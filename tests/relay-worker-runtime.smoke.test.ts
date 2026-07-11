import assert from "node:assert/strict";

import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  RELAY_GRANT_TOKEN_PREFIX,
  stableStringify,
} from "@omnilux/api-contracts";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import WebSocket from "ws";
import { relayWorkerTestHooks } from "../src/cloudflare/index.ts";

type RelayGrantPurpose = "remote_http" | "remote_ws" | "diagnostic";

type RelaySessionRecord = {
  sessionId: string;
  serverId: string;
  userId?: string;
  sessionType: string;
  metadata?: Record<string, unknown>;
};

type RelayGrantPayload = {
  contractName: "relay-grant";
  contractVersion: 1;
  grantId: string;
  serverId: string;
  ownerAccountId: string;
  subjectAccountId: string;
  audience: string;
  purpose: RelayGrantPurpose;
  scope: string[];
  issuedAt: string;
  expiresAt: string;
  sessionLimit: number;
  entitlementLeaseId: string;
  issuer: string;
  keyId: string;
  signatureAlgorithm: "ed25519";
};

const relayGrantKeys = generateKeyPairSync("ed25519");
const relayGrantPublicKeySpki = Buffer.from(
  relayGrantKeys.publicKey.export({
    type: "spki",
    format: "der",
  })
).toString("base64url");

const controlPlaneState = {
  registerCalls: [] as Array<{ token: string; body: Record<string, unknown> }>,
  heartbeatCalls: [] as Array<{ token: string; body: Record<string, unknown> }>,
  consumeCalls: [] as Array<{ token: string; body: Record<string, unknown> }>,
  sessionsByToken: new Map<string, RelaySessionRecord>(),
  serverIdsByToken: new Map<string, string>(),
};

let controlPlaneServer: ReturnType<typeof createServer>;
let controlPlaneOrigin = "";
let worker: Unstable_DevWorker;
let workerPersistDir = "";

const createSignedRelayGrantToken = (input: {
  serverId: string;
  purpose: RelayGrantPurpose;
  subjectAccountId?: string;
  issuedAt?: Date;
  expiresAt?: Date;
  audience?: string;
  sessionLimit?: number;
}) => {
  const issuedAt = input.issuedAt ?? new Date();
  const expiresAt =
    input.expiresAt ?? new Date(issuedAt.getTime() + 5 * 60 * 1000);
  const payload: RelayGrantPayload = {
    contractName: "relay-grant",
    contractVersion: 1,
    grantId: `rg_${randomUUID()}`,
    serverId: input.serverId,
    ownerAccountId: "owner-123",
    subjectAccountId: input.subjectAccountId ?? "user-123",
    audience: input.audience ?? "relay.omnilux.tv",
    purpose: input.purpose,
    scope: ["relay:session:connect"],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sessionLimit: input.sessionLimit ?? 1,
    entitlementLeaseId: "lease-test",
    issuer: "api.omnilux.tv",
    keyId: "test-key",
    signatureAlgorithm: "ed25519",
  };
  const signature = sign(
    null,
    Buffer.from(stableStringify(payload)),
    relayGrantKeys.privateKey
  ).toString("base64url");
  const grant = { ...payload, signature };
  return `${RELAY_GRANT_TOKEN_PREFIX}${Buffer.from(stableStringify(grant)).toString("base64url")}`;
};

const getBearerToken = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
};

const readJson = async (
  req: IncomingMessage
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
};

const json = (
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>
) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const withTimeout = <T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 15_000
): Promise<T> => {
  let timeout: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeout)
  );
};

const nextJsonMessage = async (
  socket: WebSocket,
  label = "websocket message",
  timeoutMs = 15_000
): Promise<Record<string, unknown>> => {
  const [raw] = await withTimeout(
    once(socket, "message"),
    `waiting for ${label}`,
    timeoutMs
  );
  const text = Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : raw.toString();
  return JSON.parse(text) as Record<string, unknown>;
};

const nextJsonMessages = (
  socket: WebSocket,
  count: number,
  label: string,
  timeoutMs = 15_000
): Promise<Array<Record<string, unknown>>> =>
  withTimeout(new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (raw: WebSocket.RawData) => {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      if (messages.length === count) {
        socket.off("message", onMessage);
        resolve(messages);
      }
    };
    socket.on("message", onMessage);
  }), `waiting for ${label}`, timeoutMs);

const closeSocket = async (
  socket: WebSocket,
  code = 1000,
  reason = "test complete"
) => {
  if (
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  )
    return;
  const closePromise = once(socket, "close");
  socket.close(code, reason);
  await closePromise;
};

const workerOrigin = () => `http://${worker.address}:${worker.port}`;
const workerWsOrigin = () => `ws://${worker.address}:${worker.port}`;

const openWebSocket = (url: string, token: string): Promise<WebSocket> =>
  withTimeout(
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          Authorization: "Bearer " + token,
        },
      });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        reject(
          new Error(`Unexpected WebSocket response ${response.statusCode}`)
        );
      });
    }),
    `opening websocket ${url}`
  );

const connectServerTunnel = async (serverId: string, tokenOverride?: string) => {
  const token = tokenOverride ?? `server-token:${serverId}`;
  controlPlaneState.serverIdsByToken.set(token, serverId);
  const socket = await openWebSocket(
    `${workerWsOrigin()}/ws/server?nonce=${randomUUID()}`,
    token
  );
  socket.send(
    JSON.stringify({
      type: "register",
      protocolVersion: 1,
      region: "cloudflare-smoke",
      clientVersion: "test-suite",
    })
  );
  const registered = await nextJsonMessage(socket, "tunnel registration");
  assert.equal(registered.type, "registered", JSON.stringify(registered));
  assert.equal(registered.serverId, serverId);
  return { socket, registered, token };
};

const beginHttpRelaySessionOnTunnel = async (
  tunnel: { socket: WebSocket },
  serverId: string,
  label: string
) => {
  const grant = createSignedRelayGrantToken({ serverId, purpose: "remote_http" });
  const sessionId = `session-${randomUUID()}`;
  controlPlaneState.sessionsByToken.set(grant, {
    sessionId,
    serverId,
    userId: "user-123",
    sessionType: "remote-access",
  });

  const sessionOpenPromise = nextJsonMessage(tunnel.socket, `${label} session-open`);
  const handoff = await fetch(`${workerOrigin()}/r/${encodeURIComponent(grant)}/stream`, {
    redirect: "manual",
  });
  assert.equal(handoff.status, 302);
  await sessionOpenPromise;
  const relayCookie = (handoff.headers.get("set-cookie") ?? "").split(";")[0];

  return { tunnel, sessionId, relayCookie };
};

const beginHttpRelaySession = async (label: string) => {
  const serverId = `server-${randomUUID()}`;
  const tunnel = await connectServerTunnel(serverId);
  return beginHttpRelaySessionOnTunnel(tunnel, serverId, label);
};

const beginHttpRelayRequest = async (label: string) => {
  const { tunnel, sessionId, relayCookie } = await beginHttpRelaySession(label);

  const requestFramePromise = nextJsonMessage(tunnel.socket, `${label} HTTP request`);
  const responsePromise = fetch(`${workerOrigin()}/stream`, {
    headers: { cookie: relayCookie },
  });
  const requestFrame = await requestFramePromise;
  const requestEnvelope = JSON.parse(String(requestFrame.data)) as Record<string, unknown>;
  assert.equal(requestEnvelope.type, "http-request");

  return {
    tunnel,
    sessionId,
    requestId: String(requestEnvelope.requestId),
    responsePromise,
  };
};

before(async () => {
  controlPlaneServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = getBearerToken(req);
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!token) {
      json(res, 401, { error: "Missing authorization" });
      return;
    }

    const body = await readJson(req);
    if (url.pathname === "/functions/v1/register-relay-connection") {
      if (!token.startsWith("server-token:")) {
        json(res, 401, { error: "Invalid relay tunnel token" });
        return;
      }
      const serverId = controlPlaneState.serverIdsByToken.get(token)
        ?? token.slice("server-token:".length);
      controlPlaneState.registerCalls.push({ token, body });
      json(res, 200, {
        ok: true,
        serverId,
        heartbeatIntervalSeconds: 1,
        relaySessionTtlSeconds: 30,
      });
      return;
    }

    if (url.pathname === "/functions/v1/relay-heartbeat") {
      controlPlaneState.heartbeatCalls.push({ token, body });
      json(res, 200, { ok: true, terminalSessions: [] });
      return;
    }

    if (url.pathname === "/functions/v1/consume-relay-session") {
      controlPlaneState.consumeCalls.push({ token, body });
      const session = controlPlaneState.sessionsByToken.get(token);
      if (!session) {
        json(res, 401, { error: "Invalid relay session token" });
        return;
      }
      json(res, 200, {
        ...session,
        connectionId: body.connectionId,
        attachAttemptId: body.attachAttemptId,
      });
      return;
    }

    json(res, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve) =>
    controlPlaneServer.listen(0, "127.0.0.1", resolve)
  );
  const address = controlPlaneServer.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to start local control plane stub");
  controlPlaneOrigin = `http://127.0.0.1:${address.port}`;
  workerPersistDir = mkdtempSync(
    path.join(tmpdir(), "omnilux-relay-worker-smoke-")
  );

  worker = await unstable_dev("src/cloudflare/index.ts", {
    config: "wrangler.jsonc",
    local: true,
    persist: true,
    persistTo: workerPersistDir,
    logLevel: "none",
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
    },
    vars: {
      RELAY_CONTROL_URL: `${controlPlaneOrigin}/functions/v1`,
      RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL: relayGrantPublicKeySpki,
      RELAY_GRANT_AUDIENCE: "relay.omnilux.tv",
      RELAY_COORDINATOR_NAME: `test-${randomUUID()}`,
      RELAY_HTTP_SESSION_COOKIE: "omnilux_relay_session",
      RELAY_HTTP_COOKIE_SECURE: "false",
      RELAY_HTTP_REQUEST_BODY_MAX_BYTES: String(64 * 1024),
      RELAY_HTTP_RESPONSE_BUFFER_MAX_BYTES: String(64 * 1024),
      RELAY_RENDEZVOUS_PARTITIONS: "64",
      RELAY_REGION: "cloudflare-smoke",
    },
  });
});

after(async () => {
  await worker?.stop();
  await new Promise<void>((resolve) =>
    controlPlaneServer?.close(() => resolve())
  );
  if (workerPersistDir)
    rmSync(workerPersistDir, { recursive: true, force: true });
});

afterEach(() => {
  controlPlaneState.registerCalls = [];
  controlPlaneState.heartbeatCalls = [];
  controlPlaneState.consumeCalls = [];
  controlPlaneState.sessionsByToken.clear();
  controlPlaneState.serverIdsByToken.clear();
});

test("Cloudflare Worker readyz fails closed when signed grants are required and no public key is configured", async () => {
  const persistTo = mkdtempSync(
    path.join(tmpdir(), "omnilux-relay-worker-missing-key-")
  );
  const workerWithoutKey = await unstable_dev("src/cloudflare/index.ts", {
    config: "wrangler.jsonc",
    local: true,
    persist: true,
    persistTo,
    logLevel: "error",
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
    },
    vars: {
      RELAY_CONTROL_URL: `${controlPlaneOrigin}/functions/v1`,
      RELAY_GRANT_AUDIENCE: "relay.omnilux.tv",
      RELAY_COORDINATOR_NAME: `missing-key-${randomUUID()}`,
    },
  });

  try {
    const response = await workerWithoutKey.fetch("/readyz");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      runtime: "cloudflare-worker",
      durableObjectBinding: true,
      rendezvousBinding: true,
      coordinatorProbe: "ok",
      rendezvousProbe: "ok",
      rendezvousPartitions: 64,
      rendezvousProbePartition: 0,
      relayGrantKeyProbe: "missing",
      signedRelayGrantVerification: "required",
    });
  } finally {
    await workerWithoutKey.stop();
    rmSync(persistTo, { recursive: true, force: true });
  }
});

test("Cloudflare Worker does not consume a signed grant before its tunnel route is visible", async () => {
  const serverId = `unregistered-${randomUUID()}`;
  const grant = createSignedRelayGrantToken({ serverId, purpose: "remote_http" });
  controlPlaneState.sessionsByToken.set(grant, {
    sessionId: `session-${randomUUID()}`,
    serverId,
    userId: "user-123",
    sessionType: "remote-access",
  });

  const response = await fetch(`${workerOrigin()}/r/${encodeURIComponent(grant)}/`, {
    redirect: "manual",
  });
  assert.equal(response.status, 503);
  assert.equal(controlPlaneState.consumeCalls.length, 0);
});

test("Cloudflare Worker relay parity smoke covers readyz, tunnel registration, signed WebSocket attach, purpose rejection, and HTTP handoff", async () => {
  const readyResponse = await worker.fetch("/readyz");
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), {
    ok: true,
    runtime: "cloudflare-worker",
    durableObjectBinding: true,
    rendezvousBinding: true,
    coordinatorProbe: "ok",
    rendezvousProbe: "ok",
    rendezvousPartitions: 64,
    rendezvousProbePartition: 0,
    relayGrantKeyProbe: "ok",
    signedRelayGrantVerification: "required",
  });

  const serverId = `server-${randomUUID()}`;
  const { socket: tunnelSocket } = await connectServerTunnel(serverId);
  assert.equal(controlPlaneState.registerCalls.length, 1);

  const wsGrant = createSignedRelayGrantToken({
    serverId,
    purpose: "remote_ws",
  });
  controlPlaneState.sessionsByToken.set(wsGrant, {
    sessionId: "session-ws",
    serverId,
    userId: "user-123",
    sessionType: "remote-access",
    metadata: { surface: "worker-ws" },
  });

  const sessionSocket = await openWebSocket(
    `${workerWsOrigin()}/ws/session?nonce=${randomUUID()}`,
    wsGrant
  );
  const tunnelOpen = await nextJsonMessage(
    tunnelSocket,
    "websocket session-open on tunnel"
  );
  assert.equal(tunnelOpen.type, "session-open");
  assert.equal(tunnelOpen.sessionId, "session-ws");
  const sessionReady = await nextJsonMessage(
    sessionSocket,
    "websocket session-ready on client"
  );
  assert.equal(sessionReady.type, "session-ready");
  assert.equal(sessionReady.sessionId, "session-ws");
  await closeSocket(sessionSocket);

  const wrongPurposeGrant = createSignedRelayGrantToken({
    serverId,
    purpose: "remote_ws",
  });
  const wrongPurposeResponse = await fetch(
    `${workerOrigin()}/r/${encodeURIComponent(wrongPurposeGrant)}/`
  );
  assert.equal(wrongPurposeResponse.status, 401);
  assert.match(
    await wrongPurposeResponse.text(),
    /Relay grant purpose is not valid for HTTP relay/
  );
  assert.equal(controlPlaneState.sessionsByToken.has(wrongPurposeGrant), false);

  const httpGrant = createSignedRelayGrantToken({
    serverId,
    purpose: "remote_http",
  });
  controlPlaneState.sessionsByToken.set(httpGrant, {
    sessionId: "session-http",
    serverId,
    userId: "user-123",
    sessionType: "remote-access",
    metadata: { surface: "worker-http" },
  });

  const httpSessionOpenPromise = nextJsonMessage(
    tunnelSocket,
    "http session-open on tunnel"
  );
  const handoffResponse = await fetch(
    `${workerOrigin()}/r/${encodeURIComponent(httpGrant)}/library?view=recent`,
    {
      redirect: "manual",
    }
  );
  assert.equal(handoffResponse.status, 302);
  assert.equal(handoffResponse.headers.get("location"), "/library?view=recent");
  const setCookie = handoffResponse.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /omnilux_relay_session=/);
  assert.match(setCookie, /SameSite=Strict/);

  const httpSessionOpen = await httpSessionOpenPromise;
  assert.equal(httpSessionOpen.type, "session-open");
  assert.equal(httpSessionOpen.sessionId, "session-http");

  const relayCookie = setCookie.split(";")[0];
  assert.match(relayCookie, /^omnilux_relay_session=v1\./);
  const requestFramePromise = nextJsonMessage(
    tunnelSocket,
    "http request frame on tunnel"
  );
  const proxiedResponsePromise = fetch(
    `${workerOrigin()}/library?view=recent`,
    {
      headers: {
        cookie: `${relayCookie}; theme=dark`,
        accept: "text/plain",
      },
    }
  );

  const requestFrame = await requestFramePromise;
  assert.equal(requestFrame.type, "session-frame");
  assert.equal(requestFrame.sessionId, "session-http");
  const requestEnvelope = JSON.parse(String(requestFrame.data)) as Record<
    string,
    unknown
  >;
  assert.equal(requestEnvelope.type, "http-request");
  assert.equal(requestEnvelope.method, "GET");
  assert.equal(requestEnvelope.path, "/library?view=recent");
  assert.ok(Array.isArray(requestEnvelope.headers));
  const forwardedHeaders = requestEnvelope.headers as Array<[string, string]>;
  assert.ok(
    forwardedHeaders.some(
      ([name, value]) => name === "accept" && value === "text/plain"
    )
  );
  assert.ok(
    forwardedHeaders.some(
      ([name, value]) => name === "cookie" && value === "theme=dark"
    )
  );
  assert.equal(
    forwardedHeaders.some(
      ([name, value]) =>
        name === "cookie" && value.includes("omnilux_relay_session=")
    ),
    false
  );

  const requestId = String(requestEnvelope.requestId);
  tunnelSocket.send(
    JSON.stringify({
      type: "http-response-start",
      sessionId: "session-http",
      requestId,
      status: 206,
      headers: [
        ["content-type", "text/plain"],
        ["set-cookie", "origin_session=ok; Path=/"],
        ["set-cookie", "omnilux_relay_session=attacker; Path=/"],
      ],
    })
  );
  tunnelSocket.send(
    JSON.stringify({
      type: "http-response-body",
      sessionId: "session-http",
      requestId,
      encoding: "base64",
      data: Buffer.from("worker hello").toString("base64"),
    })
  );
  tunnelSocket.send(
    JSON.stringify({
      type: "http-response-end",
      sessionId: "session-http",
      requestId,
    })
  );

  const proxiedResponse = await proxiedResponsePromise;
  assert.equal(proxiedResponse.status, 206);
  assert.equal(proxiedResponse.headers.get("content-type"), "text/plain");
  assert.deepEqual(proxiedResponse.headers.getSetCookie?.() ?? [], [
    "origin_session=ok; Path=/",
  ]);
  assert.equal(await proxiedResponse.text(), "worker hello");

  await closeSocket(tunnelSocket);
});

test("Cloudflare Worker routes different servers through stable rendezvous shards", async () => {
  const firstServerId = `server-${randomUUID()}`;
  const secondServerId = `server-${randomUUID()}`;
  const first = await connectServerTunnel(firstServerId);
  const second = await connectServerTunnel(secondServerId);

  assert.equal(typeof first.registered.relayShard, "string");
  assert.equal(typeof second.registered.relayShard, "string");
  assert.notEqual(first.registered.relayShard, second.registered.relayShard);

  const grant = createSignedRelayGrantToken({
    serverId: firstServerId,
    purpose: "remote_ws",
  });
  controlPlaneState.sessionsByToken.set(grant, {
    sessionId: `session-${randomUUID()}`,
    serverId: firstServerId,
    userId: "user-123",
    sessionType: "remote-access",
  });

  const client = await openWebSocket(`${workerWsOrigin()}/ws/session`, grant);
  const sessionOpen = await nextJsonMessage(first.socket, "sharded session-open");
  assert.equal(sessionOpen.type, "session-open");
  assert.equal(sessionOpen.sessionId, controlPlaneState.sessionsByToken.get(grant)?.sessionId);

  await closeSocket(client);
  await closeSocket(first.socket);
  await closeSocket(second.socket);
});

test("Cloudflare Worker distributes a concurrent tunnel registration load across shards", async () => {
  const tunnels = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      connectServerTunnel(`load-server-${index}-${randomUUID()}`)
    )
  );

  const shardKeys = tunnels.map(({ registered }) => String(registered.relayShard));
  assert.equal(new Set(shardKeys).size, tunnels.length);
  const rendezvousPartitions = tunnels.map(
    ({ registered }) => Number(registered.relayRendezvousPartition)
  );
  assert.ok(new Set(rendezvousPartitions).size >= 4);

  await Promise.all(tunnels.map(({ socket }) => closeSocket(socket)));
});

test("Cloudflare Worker reconnect moves a server rendezvous route and supersedes the old shard", async () => {
  const serverId = `server-${randomUUID()}`;
  const first = await connectServerTunnel(serverId, `server-token:${randomUUID()}`);
  const firstClosed = once(first.socket, "close");
  const second = await connectServerTunnel(serverId, `server-token:${randomUUID()}`);

  assert.notEqual(first.registered.relayShard, second.registered.relayShard);
  const [closeCode] = await withTimeout(firstClosed, "superseded tunnel close");
  assert.equal(closeCode, 1012);

  const grant = createSignedRelayGrantToken({ serverId, purpose: "remote_ws" });
  controlPlaneState.sessionsByToken.set(grant, {
    sessionId: `session-${randomUUID()}`,
    serverId,
    userId: "user-123",
    sessionType: "remote-access",
  });
  const sessionOpenPromise = nextJsonMessage(
    second.socket,
    "reconnected shard session-open"
  );
  const client = await openWebSocket(`${workerWsOrigin()}/ws/session`, grant);
  const sessionOpen = await sessionOpenPromise;
  assert.equal(sessionOpen.type, "session-open");

  await closeSocket(client);
  await closeSocket(second.socket);
});

test("Cloudflare Worker same-token retry closes the prior HTTP session before reopening", async () => {
  const serverId = `server-${randomUUID()}`;
  const tunnel = await connectServerTunnel(serverId);
  const grant = createSignedRelayGrantToken({ serverId, purpose: "remote_http" });
  const sessionId = `session-${randomUUID()}`;
  controlPlaneState.sessionsByToken.set(grant, {
    sessionId,
    serverId,
    userId: "user-123",
    sessionType: "remote-access",
  });

  const firstOpenPromise = nextJsonMessage(tunnel.socket, "first replayable session-open");
  const first = await fetch(`${workerOrigin()}/r/${encodeURIComponent(grant)}/`, {
    redirect: "manual",
  });
  assert.equal(first.status, 302);
  assert.equal((await firstOpenPromise).type, "session-open");
  const firstCookie = (first.headers.get("set-cookie") ?? "").split(";")[0];

  const retryMessagesPromise = nextJsonMessages(
    tunnel.socket,
    2,
    "retry session-close and session-open",
    30_000
  );
  const retry = await fetch(`${workerOrigin()}/r/${encodeURIComponent(grant)}/`, {
    redirect: "manual",
  });
  assert.equal(retry.status, 302);
  const retryMessages = await retryMessagesPromise;
  assert.deepEqual(retryMessages.map(({ type }) => type), [
    "session-close",
    "session-open",
  ]);
  assert.ok(retryMessages.every(({ sessionId: value }) => value === sessionId));

  const staleCookieResponse = await fetch(`${workerOrigin()}/`, {
    headers: { cookie: firstCookie },
  });
  assert.equal(staleCookieResponse.status, 404);
  const consumeCalls = controlPlaneState.consumeCalls.filter(({ token }) => token === grant);
  assert.equal(consumeCalls.length, 2);
  assert.equal(consumeCalls[0].body.attachAttemptId, consumeCalls[1].body.attachAttemptId);
  assert.equal(consumeCalls[0].body.connectionId, consumeCalls[1].body.connectionId);

  await closeSocket(tunnel.socket);
});

test("Cloudflare Worker begins a large HTTP response before the final relay frame", async () => {
  const { tunnel, sessionId, requestId, responsePromise } = await beginHttpRelayRequest(
    "streaming HTTP"
  );
  const firstChunk = Buffer.alloc(64 * 1024, 0x61);

  tunnel.socket.send(JSON.stringify({
    type: "http-response-start",
    sessionId,
    requestId,
    status: 200,
    headers: [["content-type", "application/octet-stream"]],
  }));
  tunnel.socket.send(JSON.stringify({
    type: "http-response-body",
    sessionId,
    requestId,
    encoding: "base64",
    data: firstChunk.toString("base64"),
  }));

  const responseStarted = await Promise.race([
    responsePromise.then(() => true),
    delay(750).then(() => false),
  ]);
  if (!responseStarted) {
    tunnel.socket.send(JSON.stringify({ type: "http-response-end", sessionId, requestId }));
    await responsePromise;
  }
  assert.equal(responseStarted, true, "response should resolve after response-start, not response-end");

  const response = await responsePromise;
  const reader = response.body?.getReader();
  assert.ok(reader);
  const firstRead = await reader.read();
  assert.equal(firstRead.done, false);
  assert.ok(firstRead.value.byteLength > 0);
  assert.ok(firstRead.value.every((byte) => byte === 0x61));

  const additionalChunks = Array.from(
    { length: 31 },
    (_, index) => Buffer.alloc(64 * 1024, 0x62 + (index % 2))
  );
  const received = [Buffer.from(firstRead.value)];
  let receivedBytes = firstRead.value.byteLength;
  const readUntil = async (targetBytes: number) => {
    while (receivedBytes < targetBytes) {
      const next = await withTimeout(reader.read(), "streaming HTTP response chunk", 5_000);
      assert.equal(next.done, false);
      received.push(Buffer.from(next.value));
      receivedBytes += next.value.byteLength;
    }
  };

  await readUntil(firstChunk.byteLength);
  let expectedBytes = firstChunk.byteLength;
  for (const chunk of additionalChunks) {
    tunnel.socket.send(JSON.stringify({
      type: "http-response-body",
      sessionId,
      requestId,
      encoding: "base64",
      data: chunk.toString("base64"),
    }));
    expectedBytes += chunk.byteLength;
    await readUntil(expectedBytes);
  }
  tunnel.socket.send(JSON.stringify({ type: "http-response-end", sessionId, requestId }));
  assert.equal((await withTimeout(reader.read(), "streaming HTTP response end", 5_000)).done, true);
  assert.deepEqual(
    Buffer.concat(received),
    Buffer.concat([firstChunk, ...additionalChunks])
  );

  await closeSocket(tunnel.socket);
});

test("Cloudflare Worker completes HEAD and bodyless statuses without waiting for response-end", async () => {
  const serverId = `server-${randomUUID()}`;
  const tunnel = await connectServerTunnel(serverId);
  const cases = [
    { method: "HEAD", relayStatus: 200, expectedStatus: 200 },
    { method: "GET", relayStatus: 204, expectedStatus: 204 },
    { method: "GET", relayStatus: 205, expectedStatus: 205 },
    { method: "GET", relayStatus: 304, expectedStatus: 304 },
    { method: "GET", relayStatus: 103, expectedStatus: 502 },
  ];

  for (const item of cases) {
    const label = `${item.method}-${item.relayStatus}`;
    const { sessionId, relayCookie } = await beginHttpRelaySessionOnTunnel(
      tunnel,
      serverId,
      label
    );
    const requestFramePromise = nextJsonMessage(tunnel.socket, `${label} request`);
    const responsePromise = fetch(`${workerOrigin()}/bodyless-${item.relayStatus}`, {
      method: item.method,
      headers: { cookie: relayCookie },
    });
    const requestFrame = await requestFramePromise;
    const request = JSON.parse(String(requestFrame.data)) as Record<string, unknown>;
    const requestId = String(request.requestId);
    tunnel.socket.send(JSON.stringify({
      type: "http-response-start",
      sessionId,
      requestId,
      status: item.relayStatus,
      headers: [["content-type", "text/plain"]],
    }));
    if (item.relayStatus === 103) {
      tunnel.socket.send(JSON.stringify({ type: "http-response-end", sessionId, requestId }));
    }

    const response = await withTimeout(responsePromise, `${label} response`, 1_000);
    assert.equal(response.status, item.expectedStatus);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    if (item.relayStatus !== 103) {
      tunnel.socket.send(JSON.stringify({ type: "http-response-end", sessionId, requestId }));
    }
  }

  await closeSocket(tunnel.socket);
});

test("Cloudflare Worker bounds chunked uploads and isolates concurrent request bodies", async () => {
  const servers = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const serverId = `upload-server-${index}-${randomUUID()}`;
    const tunnel = await connectServerTunnel(serverId);
    const session = await beginHttpRelaySessionOnTunnel(
      tunnel,
      serverId,
      `bounded upload ${index}`
    );
    return { serverId, tunnel, ...session };
  }));
  const [{ relayCookie }] = servers;

  const knownOversize = await fetch(`${workerOrigin()}/known-oversize`, {
    method: "POST",
    headers: { cookie: relayCookie },
    body: Buffer.alloc(64 * 1024 + 1, 0x6b),
  });
  assert.equal(knownOversize.status, 413);

  const chunkedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40 * 1024).fill(0x63));
      controller.enqueue(new Uint8Array(40 * 1024).fill(0x64));
      controller.close();
    },
  });
  const chunkedOversize = await fetch(`${workerOrigin()}/chunked-oversize`, {
    method: "POST",
    headers: { cookie: relayCookie },
    body: chunkedBody,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal(chunkedOversize.status, 413);

  const uploads = servers.map(({ tunnel, sessionId, relayCookie: cookie }, index) => {
    const body = Buffer.alloc(32 * 1024, 0x41 + index);
    return (async () => {
      const framePromise = nextJsonMessage(
        tunnel.socket,
        `concurrent upload ${index}`,
        60_000
      );
      const responsePromise = fetch(`${workerOrigin()}/upload-${index}`, {
        method: "POST",
        headers: { cookie },
        body,
      });
      const outcome = await Promise.race([
        framePromise.then((frame) => ({ frame })),
        responsePromise.then(async (response) => ({
          response,
          responseText: await response.clone().text(),
        })),
      ]);
      if (!("frame" in outcome)) {
        assert.fail(
          `upload ${index} returned ${outcome.response.status} before relay forwarding: ${outcome.responseText}`
        );
      }
      const { frame } = outcome;
      assert.equal(frame.type, "session-frame");
      const request = JSON.parse(String(frame.data)) as Record<string, unknown>;
      assert.equal(request.type, "http-request");
      assert.equal(request.path, `/upload-${index}`);
      const decoded = Buffer.from(String(request.body), "base64");
      assert.equal(decoded.byteLength, body.byteLength);
      assert.ok(decoded.every((value) => value === 0x41 + index));
      tunnel.socket.send(JSON.stringify({
        type: "http-response-start",
        sessionId,
        requestId: String(request.requestId),
        status: 204,
        headers: [],
      }));
      return (await responsePromise).status;
    })();
  });
  assert.deepEqual(await Promise.all(uploads), [204, 204, 204, 204]);

  await Promise.all(servers.map(({ tunnel }) => closeSocket(tunnel.socket)));
});

test("Cloudflare Worker bounds an unread HTTP response and cancels the upstream request", async () => {
  const { tunnel, sessionId, requestId, responsePromise } = await beginHttpRelayRequest(
    "bounded HTTP response"
  );

  tunnel.socket.send(JSON.stringify({
    type: "http-response-start",
    sessionId,
    requestId,
    status: 200,
    headers: [["content-type", "application/octet-stream"]],
  }));
  tunnel.socket.send(JSON.stringify({
    type: "http-response-body",
    sessionId,
    requestId,
    encoding: "base64",
    data: Buffer.from("first byte").toString("base64"),
  }));

  const response = await responsePromise;
  const reader = response.body?.getReader();
  assert.ok(reader);
  const initialBody = Buffer.from("first byte");
  let initialBytes = 0;
  while (initialBytes < initialBody.byteLength) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    initialBytes += chunk.value.byteLength;
  }
  assert.equal(initialBytes, initialBody.byteLength);
  const nextReadOutcome = reader.read().then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  const cancellationPromise = nextJsonMessage(tunnel.socket, "bounded response cancellation");

  tunnel.socket.send(JSON.stringify({
    type: "http-response-body",
    sessionId,
    requestId,
    encoding: "base64",
    data: Buffer.alloc(64 * 1024 + 1, 0x78).toString("base64"),
  }));

  const cancellationFrame = await cancellationPromise;
  const cancellation = JSON.parse(String(cancellationFrame.data)) as Record<string, unknown>;
  assert.equal(cancellationFrame.type, "session-frame");
  assert.equal(cancellationFrame.sessionId, sessionId);
  assert.equal(cancellation.type, "http-request-cancel");
  assert.equal(cancellation.requestId, requestId);
  assert.match(String(cancellation.reason), /bounded stream buffer/i);
  const readOutcome = await nextReadOutcome;
  assert.ok("error" in readOutcome || readOutcome.value.done);

  await closeSocket(tunnel.socket);
});

test("Cloudflare Worker readiness rejects a non-Ed25519 SPKI verification key", async () => {
  const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPublicKey = Buffer.from(rsaKeys.publicKey.export({
    type: "spki",
    format: "der",
  })).toString("base64url");
  const healthyNamespace = {
    idFromName: () => "probe-id",
    get: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
  };
  const readiness = await relayWorkerTestHooks.workerReadinessResponse({
    RELAY_COORDINATOR: healthyNamespace,
    RELAY_RENDEZVOUS: healthyNamespace,
    RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL: rsaPublicKey,
  } as never);

  assert.equal(readiness.status, 503);
  assert.equal(
    ((await readiness.json()) as Record<string, unknown>).relayGrantKeyProbe,
    "invalid"
  );
});
