import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_GRANT_TOKEN_PREFIX, stableStringify } from '@omnilux/api-contracts';
import WebSocket from 'ws';

const relayPort = 18090 + Math.floor(Math.random() * 1000);
const relayOrigin = `http://127.0.0.1:${relayPort}`;

let relayProcess: ChildProcessWithoutNullStreams;
let controlPlaneServer: ReturnType<typeof createServer>;
let controlPlaneOrigin = '';

type RelaySessionRecord = {
  sessionId: string;
  serverId: string;
  userId?: string;
  sessionType: string;
  metadata?: Record<string, unknown>;
};

type RelayGrantPayload = {
  contractName: 'relay-grant';
  contractVersion: 1;
  grantId: string;
  serverId: string;
  ownerAccountId: string;
  subjectAccountId: string;
  audience: string;
  purpose: 'remote_http' | 'remote_ws' | 'diagnostic';
  scope: string[];
  issuedAt: string;
  expiresAt: string;
  sessionLimit: number;
  entitlementLeaseId: string;
  issuer: string;
  keyId: string;
  signatureAlgorithm: 'ed25519';
};

const relayGrantKeys = generateKeyPairSync('ed25519');
const relayGrantPublicKeySpki = Buffer.from(relayGrantKeys.publicKey.export({
  type: 'spki',
  format: 'der',
})).toString('base64url');

const controlPlaneState = {
  registerCalls: [] as Array<{ token: string; body: Record<string, unknown> }>,
  heartbeatCalls: [] as Array<{ token: string; body: Record<string, unknown> }>,
  consumeCalls: [] as Array<{ token: string; body: Record<string, unknown> }>,
  sessionsByToken: new Map<string, RelaySessionRecord>(),
  terminalSessionsById: new Map<string, string>(),
};

const createSignedRelayGrantToken = (input: {
  serverId: string;
  subjectAccountId?: string;
  issuedAt?: Date;
  expiresAt?: Date;
  audience?: string;
  purpose?: RelayGrantPayload['purpose'];
  sessionLimit?: number;
}) => {
  const issuedAt = input.issuedAt ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(issuedAt.getTime() + 5 * 60 * 1000);
  const payload: RelayGrantPayload = {
    contractName: 'relay-grant',
    contractVersion: 1,
    grantId: `rg_${randomUUID()}`,
    serverId: input.serverId,
    ownerAccountId: 'owner-123',
    subjectAccountId: input.subjectAccountId ?? 'user-123',
    audience: input.audience ?? 'relay.omnilux.tv',
    purpose: input.purpose ?? 'remote_ws',
    scope: ['relay:session:connect'],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sessionLimit: input.sessionLimit ?? 1,
    entitlementLeaseId: 'lease-test',
    issuer: 'api.omnilux.tv',
    keyId: 'test-key',
    signatureAlgorithm: 'ed25519',
  };
  const signature = sign(null, Buffer.from(stableStringify(payload)), relayGrantKeys.privateKey)
    .toString('base64url');
  const grant = { ...payload, signature };
  return `${RELAY_GRANT_TOKEN_PREFIX}${Buffer.from(stableStringify(grant)).toString('base64url')}`;
};

const getBearerToken = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim();
};

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
};

const json = (res: ServerResponse, status: number, body: Record<string, unknown>) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const nextJsonMessage = async (socket: WebSocket): Promise<Record<string, unknown>> => {
  const [raw] = await once(socket, 'message');
  const text = Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString();
  return JSON.parse(text) as Record<string, unknown>;
};

const nextCloseEvent = (socket: WebSocket) =>
  new Promise<{ code: number; reason: Buffer }>((resolve, reject) => {
    socket.once('close', (code, reason) => resolve({ code, reason }));
    socket.once('error', reject);
  });

const closeSocket = async (socket: WebSocket, code = 1000, reason = 'test complete') => {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
    return;
  }

  const closePromise = once(socket, 'close');
  socket.close(code, reason);
  await closePromise;
};

const connectServerTunnel = async (token: string) => {
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/server?nonce=${randomUUID()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  await once(socket, 'open');
  socket.send(JSON.stringify({
    type: 'register',
    protocolVersion: 1,
    region: 'test-region',
    clientVersion: 'test-suite',
  }));

  const registered = await nextJsonMessage(socket);
  assert.equal(registered.type, 'registered');
  return { socket, registered };
};

const waitForHealth = async () => {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${relayOrigin}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Relay smoke server did not become healthy in time');
};

before(async () => {
  controlPlaneServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = getBearerToken(req);

    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (!token) {
      json(res, 401, { error: 'Missing authorization' });
      return;
    }

    const body = await readJson(req);

    if (url.pathname === '/functions/v1/register-relay-connection') {
      if (!token.startsWith('server-token:')) {
        json(res, 401, { error: 'Invalid relay tunnel token' });
        return;
      }

      const serverId = token.slice('server-token:'.length);
      controlPlaneState.registerCalls.push({ token, body });
      json(res, 200, {
        ok: true,
        serverId,
        heartbeatIntervalSeconds: 1,
        relaySessionTtlSeconds: 30,
      });
      return;
    }

    if (url.pathname === '/functions/v1/relay-heartbeat') {
      controlPlaneState.heartbeatCalls.push({ token, body });
      if (token === 'server-token:heartbeat-denied') {
        json(res, 401, { error: 'token revoked' });
        return;
      }

      const sessionIds = Array.isArray(body.sessionIds)
        ? body.sessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string')
        : [];
      const terminalSessions = sessionIds
        .filter((sessionId) => controlPlaneState.terminalSessionsById.has(sessionId))
        .map((sessionId) => ({
          sessionId,
          status: controlPlaneState.terminalSessionsById.get(sessionId) ?? 'revoked',
        }));

      json(res, 200, { ok: true, terminalSessions });
      return;
    }

    if (url.pathname === '/functions/v1/consume-relay-session') {
      controlPlaneState.consumeCalls.push({ token, body });
      const session = controlPlaneState.sessionsByToken.get(token);
      if (!session) {
        json(res, 401, { error: 'Invalid relay session token' });
        return;
      }

      json(res, 200, session);
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  await new Promise<void>((resolve) => controlPlaneServer.listen(0, '127.0.0.1', resolve));
  const address = controlPlaneServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start local control plane stub');
  }
  controlPlaneOrigin = `http://127.0.0.1:${address.port}`;

  relayProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RELAY_PORT: String(relayPort),
      RELAY_CONTROL_URL: `${controlPlaneOrigin}/functions/v1`,
      RELAY_HEARTBEAT_INTERVAL_MS: '1000',
      RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL: relayGrantPublicKeySpki,
    },
    stdio: 'pipe',
  });

  relayProcess.stderr.on('data', () => {});
  relayProcess.stdout.on('data', () => {});

  await waitForHealth();
});

beforeEach(() => {
  controlPlaneState.registerCalls.length = 0;
  controlPlaneState.heartbeatCalls.length = 0;
  controlPlaneState.consumeCalls.length = 0;
  controlPlaneState.sessionsByToken.clear();
  controlPlaneState.terminalSessionsById.clear();
});

afterEach(() => {
  controlPlaneState.registerCalls.length = 0;
  controlPlaneState.heartbeatCalls.length = 0;
  controlPlaneState.consumeCalls.length = 0;
  controlPlaneState.sessionsByToken.clear();
  controlPlaneState.terminalSessionsById.clear();
});

after(async () => {
  if (!relayProcess.killed) {
    relayProcess.kill('SIGTERM');
    await once(relayProcess, 'exit');
  }

  await new Promise<void>((resolve, reject) => {
    controlPlaneServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

test('health endpoints report relay availability', async () => {
  for (const path of ['/health', '/healthz']) {
    const response = await fetch(`${relayOrigin}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
});

test('server tunnel websocket rejects unauthenticated clients', async () => {
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/server?nonce=${randomUUID()}`);

  const closeEvent = await new Promise<{ code: number; reason: Buffer }>((resolve, reject) => {
    socket.once('close', (code, reason) => resolve({ code, reason }));
    socket.once('error', reject);
  });

  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Missing relay tunnel token/);
});

test('session websocket rejects unauthenticated clients', async () => {
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`);

  const closeEvent = await nextCloseEvent(socket);

  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Missing relay session token/);
});

test('server tunnel registers and acknowledges heartbeats through the control plane', async () => {
  const { socket, registered } = await connectServerTunnel('server-token:server-registered');
  assert.equal(registered.serverId, 'server-registered');
  assert.equal(controlPlaneState.registerCalls.length, 1);

  socket.send(JSON.stringify({ type: 'heartbeat' }));
  const heartbeatAck = await nextJsonMessage(socket);
  assert.equal(heartbeatAck.type, 'heartbeat-ack');
  assert.equal(heartbeatAck.relayCondition, 'connected');
  assert.equal(heartbeatAck.reasonCode, 'ok');
  assert.equal(controlPlaneState.heartbeatCalls.length, 1);

  await closeSocket(socket);
});

test('newer tunnels supersede older tunnels for the same server', async () => {
  const first = await connectServerTunnel('server-token:server-replaced');
  const second = await connectServerTunnel('server-token:server-replaced');
  const closeEvent = await nextCloseEvent(first.socket);

  assert.equal(closeEvent.code, 1012);
  assert.match(closeEvent.reason.toString('utf8'), /Superseded by a newer tunnel/);

  await closeSocket(second.socket);
});

test('session websockets attach to an active tunnel and forward frames both directions', async () => {
  controlPlaneState.sessionsByToken.set('session-token:server-session', {
    sessionId: 'session-123',
    serverId: 'server-session',
    userId: 'user-123',
    sessionType: 'game-stream',
    metadata: { resolution: '1080p' },
  });

  const { socket: tunnelSocket } = await connectServerTunnel('server-token:server-session');
  const sessionSocket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: 'Bearer session-token:server-session',
    },
  });

  await once(sessionSocket, 'open');
  const tunnelOpen = await nextJsonMessage(tunnelSocket);
  assert.deepEqual(tunnelOpen, {
    type: 'session-open',
    sessionId: 'session-123',
    sessionType: 'game-stream',
    metadata: { resolution: '1080p' },
  });

  const sessionReady = await nextJsonMessage(sessionSocket);
  assert.deepEqual(sessionReady, {
    type: 'session-ready',
    sessionId: 'session-123',
    serverId: 'server-session',
  });

  sessionSocket.send('hello relay');
  const forwardedFrame = await nextJsonMessage(tunnelSocket);
  assert.deepEqual(forwardedFrame, {
    type: 'session-frame',
    sessionId: 'session-123',
    encoding: 'text',
    data: 'hello relay',
  });

  tunnelSocket.send(JSON.stringify({
    type: 'session-frame',
    sessionId: 'session-123',
    encoding: 'text',
    data: 'hello client',
  }));
  const [clientFrame] = await once(sessionSocket, 'message');
  assert.equal(clientFrame.toString(), 'hello client');

  const tunnelClosePromise = nextJsonMessage(tunnelSocket);
  await closeSocket(sessionSocket);
  const tunnelCloseMessage = await tunnelClosePromise;
  assert.equal(tunnelCloseMessage.type, 'session-close');
  assert.equal(tunnelCloseMessage.sessionId, 'session-123');
  assert.equal(tunnelCloseMessage.reasonCode, 'client_socket_error');

  await closeSocket(tunnelSocket);
});

test('session websocket verifies a signed relay grant before attaching', async () => {
  const token = createSignedRelayGrantToken({ serverId: 'server-signed-session' });
  controlPlaneState.sessionsByToken.set(token, {
    sessionId: 'session-signed',
    serverId: 'server-signed-session',
    userId: 'user-123',
    sessionType: 'remote-access',
    metadata: { signed: true },
  });

  const { socket: tunnelSocket } = await connectServerTunnel('server-token:server-signed-session');
  const sessionSocket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  await once(sessionSocket, 'open');
  const tunnelOpen = await nextJsonMessage(tunnelSocket);
  assert.deepEqual(tunnelOpen, {
    type: 'session-open',
    sessionId: 'session-signed',
    sessionType: 'remote-access',
    metadata: { signed: true },
  });

  const sessionReady = await nextJsonMessage(sessionSocket);
  assert.deepEqual(sessionReady, {
    type: 'session-ready',
    sessionId: 'session-signed',
    serverId: 'server-signed-session',
  });
  assert.equal(controlPlaneState.consumeCalls.length, 1);

  await closeSocket(sessionSocket);
  await closeSocket(tunnelSocket);
});

test('session websocket closes when heartbeat reports the consumed session was revoked', async () => {
  const token = createSignedRelayGrantToken({ serverId: 'server-revoked-session' });
  controlPlaneState.sessionsByToken.set(token, {
    sessionId: 'session-revoked',
    serverId: 'server-revoked-session',
    userId: 'user-123',
    sessionType: 'remote-access',
    metadata: { signed: true },
  });

  const { socket: tunnelSocket } = await connectServerTunnel('server-token:server-revoked-session');
  const sessionSocket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  await once(sessionSocket, 'open');
  await nextJsonMessage(tunnelSocket);
  await nextJsonMessage(sessionSocket);

  controlPlaneState.terminalSessionsById.set('session-revoked', 'revoked');
  const closeEventPromise = nextCloseEvent(sessionSocket);
  tunnelSocket.send(JSON.stringify({ type: 'heartbeat' }));

  const sessionClose = await nextJsonMessage(tunnelSocket);
  assert.equal(sessionClose.type, 'session-close');
  assert.equal(sessionClose.sessionId, 'session-revoked');
  assert.equal(sessionClose.relayCondition, 'revoked');
  assert.equal(sessionClose.reasonCode, 'token_revoked');

  const closeEvent = await closeEventPromise;
  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Relay session revoked/);

  await closeSocket(tunnelSocket);
});

test('browser HTTP relay handoff proxies requests over an active tunnel', async () => {
  const token = createSignedRelayGrantToken({ serverId: 'server-http-relay', purpose: 'remote_http' });
  controlPlaneState.sessionsByToken.set(token, {
    sessionId: 'session-http',
    serverId: 'server-http-relay',
    userId: 'user-123',
    sessionType: 'remote-access',
    metadata: { surface: 'browser' },
  });

  const { socket: tunnelSocket } = await connectServerTunnel('server-token:server-http-relay');
  const sessionOpenPromise = nextJsonMessage(tunnelSocket);
  const handoffResponse = await fetch(`${relayOrigin}/r/${encodeURIComponent(token)}/library?view=recent`, {
    redirect: 'manual',
  });
  assert.equal(handoffResponse.status, 302);
  assert.equal(handoffResponse.headers.get('location'), '/library?view=recent');
  const relayCookie = handoffResponse.headers.get('set-cookie')?.split(';')[0];
  assert.match(relayCookie ?? '', /^omnilux_relay_session=/);

  const sessionOpen = await sessionOpenPromise;
  assert.deepEqual(sessionOpen, {
    type: 'session-open',
    sessionId: 'session-http',
    sessionType: 'remote-access',
    metadata: { surface: 'browser' },
  });

  const requestFramePromise = nextJsonMessage(tunnelSocket);
  const proxiedResponsePromise = fetch(`${relayOrigin}/api/health`, {
    headers: {
      cookie: relayCookie ?? '',
      range: 'bytes=0-4',
    },
  });

  const requestFrame = await requestFramePromise;
  assert.equal(requestFrame.type, 'session-frame');
  assert.equal(requestFrame.sessionId, 'session-http');
  assert.equal(requestFrame.encoding, 'text');
  const requestEnvelope = JSON.parse(String(requestFrame.data)) as {
    type: string;
    requestId: string;
    method: string;
    path: string;
    headers: Array<[string, string]>;
  };
  assert.equal(requestEnvelope.type, 'http-request');
  assert.equal(requestEnvelope.method, 'GET');
  assert.equal(requestEnvelope.path, '/api/health');
  assert.ok(requestEnvelope.headers.some(([name, value]) => name === 'range' && value === 'bytes=0-4'));

  tunnelSocket.send(JSON.stringify({
    type: 'http-response-start',
    sessionId: 'session-http',
    requestId: requestEnvelope.requestId,
    status: 206,
    statusText: 'Partial Content',
    headers: [
      ['content-type', 'application/json'],
      ['content-range', 'bytes 0-4/11'],
    ],
  }));
  tunnelSocket.send(JSON.stringify({
    type: 'http-response-body',
    sessionId: 'session-http',
    requestId: requestEnvelope.requestId,
    encoding: 'base64',
    data: Buffer.from('hello').toString('base64'),
  }));
  tunnelSocket.send(JSON.stringify({
    type: 'http-response-end',
    sessionId: 'session-http',
    requestId: requestEnvelope.requestId,
  }));

  const proxiedResponse = await proxiedResponsePromise;
  assert.equal(proxiedResponse.status, 206);
  assert.equal(proxiedResponse.headers.get('content-range'), 'bytes 0-4/11');
  assert.equal(await proxiedResponse.text(), 'hello');

  await closeSocket(tunnelSocket);
});

test('session websocket rejects signed grants for the wrong audience before control-plane consumption', async () => {
  const token = createSignedRelayGrantToken({
    serverId: 'server-wrong-audience-grant',
    audience: 'wrong-relay.omnilux.tv',
  });
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const closeEvent = await nextCloseEvent(socket);
  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Relay grant audience mismatch/);
  assert.equal(controlPlaneState.consumeCalls.length, 0);
});

test('session websocket rejects signed grants whose consumed session binding does not match', async () => {
  const token = createSignedRelayGrantToken({ serverId: 'server-bound-in-grant' });
  controlPlaneState.sessionsByToken.set(token, {
    sessionId: 'session-binding-mismatch',
    serverId: 'server-returned-by-control-plane',
    userId: 'user-123',
    sessionType: 'remote-access',
  });

  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const closeEvent = await nextCloseEvent(socket);
  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Relay grant does not match consumed session/);
  assert.equal(controlPlaneState.consumeCalls.length, 1);
});

test('session websocket rejects expired signed grants before control-plane consumption', async () => {
  const issuedAt = new Date(Date.now() - 10 * 60 * 1000);
  const token = createSignedRelayGrantToken({
    serverId: 'server-expired-grant',
    issuedAt,
    expiresAt: new Date(Date.now() - 1000),
  });
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const closeEvent = await nextCloseEvent(socket);
  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Relay grant has expired/);
  assert.equal(controlPlaneState.consumeCalls.length, 0);
});

test('session websocket rejects signed grants with an excessive TTL before control-plane consumption', async () => {
  const issuedAt = new Date();
  const token = createSignedRelayGrantToken({
    serverId: 'server-long-ttl-grant',
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000),
  });
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const closeEvent = await nextCloseEvent(socket);
  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Relay grant TTL exceeds maximum/);
  assert.equal(controlPlaneState.consumeCalls.length, 0);
});

test('session websocket rejects signed grants with more than one session before control-plane consumption', async () => {
  const token = createSignedRelayGrantToken({
    serverId: 'server-multi-session-grant',
    sessionLimit: 2,
  });
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const closeEvent = await nextCloseEvent(socket);
  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Relay grant session limit must be exactly one/);
  assert.equal(controlPlaneState.consumeCalls.length, 0);
});

test('session websocket fails with not-found semantics when the control plane resolves a missing tunnel', async () => {
  controlPlaneState.sessionsByToken.set('session-token:no-tunnel', {
    sessionId: 'session-missing',
    serverId: 'server-without-tunnel',
    sessionType: 'remote-play',
  });

  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`, {
    headers: {
      Authorization: 'Bearer session-token:no-tunnel',
    },
  });

  const closeEvent = await nextCloseEvent(socket);
  assert.equal(closeEvent.code, 4404);
  assert.match(closeEvent.reason.toString('utf8'), /No active relay tunnel for this server/);
});
