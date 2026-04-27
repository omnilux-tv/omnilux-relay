import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
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

const controlPlaneState = {
  registerCalls: [] as Array<{ token: string; body: Record<string, unknown> }>,
  heartbeatCalls: [] as Array<{ token: string; body: Record<string, unknown> }>,
  sessionsByToken: new Map<string, RelaySessionRecord>(),
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

      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/functions/v1/consume-relay-session') {
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

  relayProcess = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RELAY_PORT: String(relayPort),
      RELAY_CONTROL_URL: `${controlPlaneOrigin}/functions/v1`,
      RELAY_HEARTBEAT_INTERVAL_MS: '1000',
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
  controlPlaneState.sessionsByToken.clear();
});

afterEach(() => {
  controlPlaneState.registerCalls.length = 0;
  controlPlaneState.heartbeatCalls.length = 0;
  controlPlaneState.sessionsByToken.clear();
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

test('health endpoint reports relay availability', async () => {
  const response = await fetch(`${relayOrigin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
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
