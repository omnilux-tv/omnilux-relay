import 'dotenv/config';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

type JsonRecord = Record<string, unknown>;

interface TunnelConnection {
  serverId: string;
  connectionId: string;
  token: string;
  socket: WebSocket;
  registeredAt: string;
  protocolVersion: number;
  region?: string;
  clientVersion?: string;
  capabilities?: Record<string, unknown>;
  sessions: Set<string>;
}

interface RelaySession {
  sessionId: string;
  serverId: string;
  userId?: string;
  sessionType: string;
  clientSocket: WebSocket;
  tunnelConnectionId: string;
  openedAt: string;
}

const relayLog = (message: string, data?: JsonRecord) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'relay',
    message,
    ...(data ? { data } : {}),
  }));
};

const relayWarn = (message: string, data?: JsonRecord) => {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'relay',
    level: 'warn',
    message,
    ...(data ? { data } : {}),
  }));
};

const relayError = (message: string, data?: JsonRecord) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'relay',
    level: 'error',
    message,
    ...(data ? { data } : {}),
  }));
};

const RELAY_PORT = Number(process.env.RELAY_PORT ?? 8090);
const RELAY_CONTROL_URL = process.env.RELAY_CONTROL_URL ?? 'https://api.omnilux.tv/functions/v1';
const RELAY_HEARTBEAT_INTERVAL_MS = Number(process.env.RELAY_HEARTBEAT_INTERVAL_MS ?? 30_000);

const tunnelsByServerId = new Map<string, TunnelConnection>();
const tunnelsByConnectionId = new Map<string, TunnelConnection>();
const sessionsById = new Map<string, RelaySession>();

function getBearerToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice(7).trim();
}

function parseJson(raw: RawData): JsonRecord | null {
  try {
    return JSON.parse(rawDataToString(raw)) as JsonRecord;
  } catch {
    return null;
  }
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw.map(rawChunkToBuffer)).toString('utf8');
  return rawChunkToBuffer(raw).toString('utf8');
}

function rawDataToBuffer(raw: RawData): Buffer {
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw.map(rawChunkToBuffer));
  return rawChunkToBuffer(raw);
}

function rawChunkToBuffer(raw: ArrayBuffer | Buffer): Buffer {
  return raw instanceof ArrayBuffer ? Buffer.from(new Uint8Array(raw)) : Buffer.from(raw);
}

async function postControlPlane<T>(
  path: string,
  token: string,
  body: JsonRecord,
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const response = await fetch(`${RELAY_CONTROL_URL}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) as T : undefined;

    return response.ok
      ? { ok: true, status: response.status, data }
      : { ok: false, status: response.status, error: (data as { error?: string } | undefined)?.error ?? text };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : 'Unknown relay control-plane error',
    };
  }
}

function sendJson(socket: WebSocket, payload: JsonRecord) {
  socket.send(JSON.stringify(payload));
}

function closeSession(sessionId: string, code = 1011, reason = 'Relay session closed') {
  const session = sessionsById.get(sessionId);
  if (!session) return;

  sessionsById.delete(sessionId);
  const tunnel = tunnelsByConnectionId.get(session.tunnelConnectionId);
  tunnel?.sessions.delete(sessionId);

  if (session.clientSocket.readyState === WebSocket.OPEN || session.clientSocket.readyState === WebSocket.CONNECTING) {
    session.clientSocket.close(code, reason);
  }

  if (tunnel?.socket.readyState === WebSocket.OPEN) {
    sendJson(tunnel.socket, {
      type: 'session-close',
      sessionId,
      reason,
    });
  }
}

function dropTunnel(connectionId: string, reason: string) {
  const tunnel = tunnelsByConnectionId.get(connectionId);
  if (!tunnel) return;

  tunnelsByConnectionId.delete(connectionId);
  if (tunnelsByServerId.get(tunnel.serverId)?.connectionId === connectionId) {
    tunnelsByServerId.delete(tunnel.serverId);
  }

  for (const sessionId of Array.from(tunnel.sessions)) {
    closeSession(sessionId, 1011, reason);
  }
}

async function registerTunnel(socket: WebSocket, token: string, payload: JsonRecord) {
  const protocolVersion = Number(payload.protocolVersion);
  if (!Number.isFinite(protocolVersion)) {
    sendJson(socket, { type: 'error', code: 'INVALID_REGISTER', message: 'protocolVersion is required' });
    socket.close(1008, 'Invalid register payload');
    return;
  }

  const connectionId = crypto.randomUUID();
  const response = await postControlPlane<{
    ok: boolean;
    serverId: string;
    heartbeatIntervalSeconds: number;
    relaySessionTtlSeconds: number;
  }>('register-relay-connection', token, {
    connectionId,
    protocolVersion,
    region: typeof payload.region === 'string' ? payload.region : undefined,
    clientVersion: typeof payload.clientVersion === 'string' ? payload.clientVersion : undefined,
    capabilities: typeof payload.capabilities === 'object' && payload.capabilities ? payload.capabilities : {},
    metadata: typeof payload.metadata === 'object' && payload.metadata ? payload.metadata : {},
  });

  if (!response.ok || !response.data) {
    sendJson(socket, { type: 'error', code: 'REGISTER_FAILED', message: response.error ?? 'Relay registration failed' });
    socket.close(1011, 'Relay registration failed');
    return;
  }

  const existing = tunnelsByServerId.get(response.data.serverId);
  if (existing) {
    dropTunnel(existing.connectionId, 'Superseded by a newer tunnel');
    if (existing.socket.readyState === WebSocket.OPEN || existing.socket.readyState === WebSocket.CONNECTING) {
      existing.socket.close(1012, 'Superseded by a newer tunnel');
    }
  }

  const tunnel: TunnelConnection = {
    serverId: response.data.serverId,
    connectionId,
    token,
    socket,
    registeredAt: new Date().toISOString(),
    protocolVersion,
    region: typeof payload.region === 'string' ? payload.region : undefined,
    clientVersion: typeof payload.clientVersion === 'string' ? payload.clientVersion : undefined,
    capabilities: typeof payload.capabilities === 'object' && payload.capabilities
      ? payload.capabilities as Record<string, unknown>
      : undefined,
    sessions: new Set(),
  };

  tunnelsByServerId.set(tunnel.serverId, tunnel);
  tunnelsByConnectionId.set(connectionId, tunnel);

  sendJson(socket, {
    type: 'registered',
    serverId: tunnel.serverId,
    connectionId,
    heartbeatIntervalSeconds: response.data.heartbeatIntervalSeconds,
    relaySessionTtlSeconds: response.data.relaySessionTtlSeconds,
  });

  relayLog('relay tunnel registered', {
    serverId: tunnel.serverId,
    connectionId,
    protocolVersion,
  });
}

async function handleTunnelHeartbeat(tunnel: TunnelConnection, payload: JsonRecord) {
  const response = await postControlPlane<{ ok: boolean }>('relay-heartbeat', tunnel.token, {
    connectionId: tunnel.connectionId,
    relayStatus: typeof payload.relayStatus === 'string' ? payload.relayStatus : 'online',
    protocolVersion: typeof payload.protocolVersion === 'number' ? payload.protocolVersion : tunnel.protocolVersion,
    region: typeof payload.region === 'string' ? payload.region : tunnel.region,
    clientVersion: typeof payload.clientVersion === 'string' ? payload.clientVersion : tunnel.clientVersion,
    capabilities: typeof payload.capabilities === 'object' && payload.capabilities ? payload.capabilities : tunnel.capabilities ?? {},
    metadata: typeof payload.metadata === 'object' && payload.metadata ? payload.metadata : {},
  });

  if (!response.ok) {
    relayWarn('relay heartbeat failed', {
      serverId: tunnel.serverId,
      connectionId: tunnel.connectionId,
      error: response.error,
    });
  }
}

async function attachClientSession(clientSocket: WebSocket, token: string) {
  const connectionId = crypto.randomUUID();
  const response = await postControlPlane<{
    sessionId: string;
    serverId: string;
    userId?: string;
    sessionType: string;
    metadata?: Record<string, unknown>;
  }>('consume-relay-session', token, { connectionId });

  if (!response.ok || !response.data) {
    clientSocket.close(4401, response.error ?? 'Invalid relay session');
    return;
  }

  const tunnel = tunnelsByServerId.get(response.data.serverId);
  if (!tunnel) {
    clientSocket.close(4404, 'No active relay tunnel for this server');
    return;
  }

  const session: RelaySession = {
    sessionId: response.data.sessionId,
    serverId: response.data.serverId,
    userId: response.data.userId,
    sessionType: response.data.sessionType,
    clientSocket,
    tunnelConnectionId: tunnel.connectionId,
    openedAt: new Date().toISOString(),
  };

  sessionsById.set(session.sessionId, session);
  tunnel.sessions.add(session.sessionId);

  sendJson(tunnel.socket, {
    type: 'session-open',
    sessionId: session.sessionId,
    sessionType: session.sessionType,
    metadata: response.data.metadata ?? {},
  });

  sendJson(clientSocket, {
    type: 'session-ready',
    sessionId: session.sessionId,
    serverId: session.serverId,
  });

  relayLog('relay session attached', {
    serverId: session.serverId,
    sessionId: session.sessionId,
    connectionId: tunnel.connectionId,
  });

  clientSocket.on('message', (raw, isBinary) => {
    if (tunnel.socket.readyState !== WebSocket.OPEN) {
      closeSession(session.sessionId, 1011, 'Relay tunnel is not available');
      return;
    }

    sendJson(tunnel.socket, {
      type: 'session-frame',
      sessionId: session.sessionId,
      encoding: isBinary ? 'base64' : 'text',
      data: isBinary ? rawDataToBuffer(raw).toString('base64') : rawDataToString(raw),
    });
  });

  clientSocket.on('close', () => {
    closeSession(session.sessionId, 1000, 'Client disconnected');
  });

  clientSocket.on('error', () => {
    closeSession(session.sessionId, 1011, 'Client socket error');
  });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const server = createServer(app);
const tunnelWss = new WebSocketServer({ noServer: true });
const sessionWss = new WebSocketServer({ noServer: true });

tunnelWss.on('connection', (socket, req) => {
  const token = getBearerToken(req);
  if (!token) {
    socket.close(4401, 'Missing relay tunnel token');
    return;
  }

  let tunnelConnectionId: string | null = null;

  const heartbeatTimer = setInterval(async () => {
    if (!tunnelConnectionId) return;
    const tunnel = tunnelsByConnectionId.get(tunnelConnectionId);
    if (!tunnel) return;
    await handleTunnelHeartbeat(tunnel, {});
  }, RELAY_HEARTBEAT_INTERVAL_MS);

  socket.on('message', async (raw) => {
    const payload = parseJson(raw);
    if (!payload || typeof payload.type !== 'string') {
      sendJson(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Expected JSON message with type' });
      return;
    }

    if (payload.type === 'register') {
      await registerTunnel(socket, token, payload);
      const registered = Array.from(tunnelsByConnectionId.values()).find((candidate) => candidate.socket === socket);
      tunnelConnectionId = registered?.connectionId ?? null;
      return;
    }

    if (!tunnelConnectionId) {
      sendJson(socket, { type: 'error', code: 'NOT_REGISTERED', message: 'Tunnel must register before sending frames' });
      return;
    }

    const tunnel = tunnelsByConnectionId.get(tunnelConnectionId);
    if (!tunnel) {
      sendJson(socket, { type: 'error', code: 'UNKNOWN_TUNNEL', message: 'Relay tunnel is not active' });
      return;
    }

    switch (payload.type) {
      case 'heartbeat':
        await handleTunnelHeartbeat(tunnel, payload);
        sendJson(socket, {
          type: 'heartbeat-ack',
          connectionId: tunnel.connectionId,
          receivedAt: new Date().toISOString(),
        });
        break;
      case 'session-frame': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
        const session = sessionId ? sessionsById.get(sessionId) : null;
        if (!session) return;
        if (session.clientSocket.readyState !== WebSocket.OPEN) {
          closeSession(session.sessionId, 1000, 'Client socket no longer open');
          return;
        }

        const encoding = payload.encoding === 'base64' ? 'base64' : 'text';
        const frame = typeof payload.data === 'string' ? payload.data : '';
        if (encoding === 'base64') {
          session.clientSocket.send(Buffer.from(frame, 'base64'));
        } else {
          session.clientSocket.send(frame);
        }
        break;
      }
      case 'session-close': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
        if (sessionId) {
          closeSession(
            sessionId,
            1000,
            typeof payload.reason === 'string' ? payload.reason : 'Session closed by server',
          );
        }
        break;
      }
      default:
        sendJson(socket, {
          type: 'error',
          code: 'UNKNOWN_TYPE',
          message: `Unknown tunnel message type: ${payload.type}`,
        });
    }
  });

  socket.on('close', () => {
    clearInterval(heartbeatTimer);
    if (tunnelConnectionId) {
      relayWarn('relay tunnel disconnected', { connectionId: tunnelConnectionId });
      dropTunnel(tunnelConnectionId, 'Relay tunnel disconnected');
    }
  });

  socket.on('error', (error) => {
    relayError('relay tunnel socket error', {
      error: error instanceof Error ? error.message : 'Unknown websocket error',
      ...(tunnelConnectionId ? { connectionId: tunnelConnectionId } : {}),
    });
  });
});

sessionWss.on('connection', (socket, req) => {
  const token = getBearerToken(req);
  if (!token) {
    socket.close(4401, 'Missing relay session token');
    return;
  }

  attachClientSession(socket, token).catch((error) => {
    relayError('relay client session attach failed', {
      error: error instanceof Error ? error.message : 'Unknown session attach error',
    });
    socket.close(1011, 'Relay session attach failed');
  });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = req.url ? new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname : '';

  if (pathname === '/ws/server') {
    tunnelWss.handleUpgrade(req, socket, head, (ws) => {
      tunnelWss.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/ws/session') {
    sessionWss.handleUpgrade(req, socket, head, (ws) => {
      sessionWss.emit('connection', ws, req);
    });
    return;
  }

  socket.destroy();
});

server.listen(RELAY_PORT, () => {
  relayLog('relay runtime listening', {
    port: RELAY_PORT,
    controlUrl: RELAY_CONTROL_URL,
  });
});
