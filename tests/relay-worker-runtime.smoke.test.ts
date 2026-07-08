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
import {
  RELAY_GRANT_TOKEN_PREFIX,
  stableStringify,
} from "@omnilux/api-contracts";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import WebSocket from "ws";

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
  label = "websocket message"
): Promise<Record<string, unknown>> => {
  const [raw] = await withTimeout(
    once(socket, "message"),
    `waiting for ${label}`
  );
  const text = Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : raw.toString();
  return JSON.parse(text) as Record<string, unknown>;
};

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

const connectServerTunnel = async (serverId: string) => {
  const token = `server-token:${serverId}`;
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
      const serverId = token.slice("server-token:".length);
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
      json(res, 200, session);
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
    logLevel: "error",
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
      signedRelayGrantVerification: "required",
    });
  } finally {
    await workerWithoutKey.stop();
    rmSync(persistTo, { recursive: true, force: true });
  }
});

test("Cloudflare Worker relay parity smoke covers readyz, tunnel registration, signed WebSocket attach, purpose rejection, and HTTP handoff", async () => {
  const readyResponse = await worker.fetch("/readyz");
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), {
    ok: true,
    runtime: "cloudflare-worker",
    durableObjectBinding: true,
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

test("Cloudflare Worker signed grant verification rejects invalid public keys without consuming sessions", async () => {
  const invalidKeyPersistTo = mkdtempSync(
    path.join(tmpdir(), "omnilux-relay-worker-invalid-key-")
  );
  const workerWithInvalidKey = await unstable_dev("src/cloudflare/index.ts", {
    config: "wrangler.jsonc",
    local: true,
    persist: true,
    persistTo: invalidKeyPersistTo,
    logLevel: "error",
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
    },
    vars: {
      RELAY_CONTROL_URL: `${controlPlaneOrigin}/functions/v1`,
      RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL: "not-a-valid-spki-key",
      RELAY_GRANT_AUDIENCE: "relay.omnilux.tv",
      RELAY_COORDINATOR_NAME: `invalid-key-${randomUUID()}`,
    },
  });

  try {
    const token = createSignedRelayGrantToken({
      serverId: "server-invalid-key",
      purpose: "remote_ws",
    });
    await assert.rejects(
      () =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(
            `ws://${workerWithInvalidKey.address}:${workerWithInvalidKey.port}/ws/session`,
            {
              headers: { Authorization: "Bearer " + token },
            }
          );
          socket.once("open", () => resolve(socket));
          socket.once("error", reject);
          socket.once("unexpected-response", (_request, response) => {
            reject(
              new Error(`Unexpected WebSocket response ${response.statusCode}`)
            );
          });
        }),
      /Unexpected WebSocket response 401/
    );
    assert.equal(controlPlaneState.consumeCalls.length, 0);
  } finally {
    await workerWithInvalidKey.stop();
    rmSync(invalidKeyPersistTo, { recursive: true, force: true });
  }
});
