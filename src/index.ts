import 'dotenv/config';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import express, { type Request, type Response } from 'express';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  addConditionMetadata,
  classifyRelayCondition,
  isTerminalRelayCondition,
  relayStatusForControlPlane,
  toCloseReason,
  type JsonRecord,
  type RelayConditionResult,
} from './relay-condition.js';
import {
  parseSignedRelayGrantToken,
  verifyRelayGrantToken as verifyRelayGrantTokenWithPolicy,
  type RelayGrant,
} from './relay-grant-verification.js';
import { createRelayControlPlaneClient } from './relay-control-plane.js';
import {
  closePendingHttpRelayRequests,
  endPendingHttpRelayRequest,
  failPendingHttpRelayRequest,
  openPendingHttpRelayRequest,
  readRelayHttpRequestBody,
  removePendingHttpRelayRequest,
  sanitizeRelayIncomingHeaders,
  startRelayHttpResponse,
  writeRelayHttpResponseBody,
} from './relay-http-stream.js';
import {
  clearRelaySessionCookie,
  closeExpiredHttpRelaySessions as closeExpiredStoredHttpRelaySessions,
  createHttpRelaySessionRecord,
  createRelayHttpSessionStore,
  findHttpRelaySessionFromCookie,
  relayHandoffRedirectTarget,
  relaySessionCookie,
  relaySessionMaxAgeSeconds,
  type HttpRelaySession,
} from './relay-http-session.js';
import { attachRelaySession } from './relay-session-attachment.js';
import {
  createRelayTunnelRegistry,
  type TunnelConnection,
} from './relay-tunnel-registry.js';

interface RelaySession {
  sessionId: string;
  serverId: string;
  userId?: string;
  sessionType: string;
  clientSocket: WebSocket;
  tunnelConnectionId: string;
  openedAt: string;
  expiresAt: number;
  expiryTimer?: NodeJS.Timeout;
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
const RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL = process.env.RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL?.trim() ?? '';
const RELAY_GRANT_AUDIENCE = process.env.RELAY_GRANT_AUDIENCE?.trim() || 'relay.omnilux.tv';
const RELAY_ALLOW_LEGACY_SESSION_GRANTS = process.env.RELAY_ALLOW_LEGACY_SESSION_GRANTS === 'true';
const RELAY_REQUIRE_SIGNED_SESSION_GRANTS = !RELAY_ALLOW_LEGACY_SESSION_GRANTS;
const RELAY_GRANT_MAX_CLOCK_SKEW_MS = Number(process.env.RELAY_GRANT_MAX_CLOCK_SKEW_MS ?? 30_000);
const RELAY_GRANT_MAX_TTL_MS = Number(process.env.RELAY_GRANT_MAX_TTL_MS ?? 5 * 60 * 1000);
const RELAY_HTTP_SESSION_COOKIE = process.env.RELAY_HTTP_SESSION_COOKIE?.trim() || 'omnilux_relay_session';
const RELAY_HTTP_SESSION_TTL_MS = Number(process.env.RELAY_HTTP_SESSION_TTL_MS ?? 4 * 60 * 60 * 1000);
const RELAY_HTTP_REQUEST_TIMEOUT_MS = Number(process.env.RELAY_HTTP_REQUEST_TIMEOUT_MS ?? 10 * 60 * 1000);
const RELAY_HTTP_REQUEST_BODY_MAX_BYTES = Number(process.env.RELAY_HTTP_REQUEST_BODY_MAX_BYTES ?? 25 * 1024 * 1024);

const tunnelRegistry = createRelayTunnelRegistry();
const sessionsById = new Map<string, RelaySession>();
const httpSessionStore = createRelayHttpSessionStore();
const relayControlPlane = createRelayControlPlaneClient({
  baseUrl: RELAY_CONTROL_URL,
});

if (RELAY_REQUIRE_SIGNED_SESSION_GRANTS && !RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL) {
  relayError('relay grant verification public key is required when signed session grants are enforced');
  process.exit(1);
}

function getBearerToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice(7).trim();
}

async function verifyRelayGrantToken(token: string): Promise<{
  ok: true;
  grant?: RelayGrant;
} | {
  ok: false;
  condition: RelayConditionResult;
}> {
  const result = await verifyRelayGrantTokenWithPolicy(token, {
    requireSignedSessionGrants: RELAY_REQUIRE_SIGNED_SESSION_GRANTS,
    publicKeySpkiBase64Url: RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL,
    audience: RELAY_GRANT_AUDIENCE,
    maxClockSkewMs: RELAY_GRANT_MAX_CLOCK_SKEW_MS,
    maxTtlMs: RELAY_GRANT_MAX_TTL_MS,
  });

  if (!result.ok && result.condition.detail === 'Relay grant signature is invalid') {
    const grant = parseSignedRelayGrantToken(token);
    relayWarn('relay grant signature rejected', {
      grantId: grant?.grantId,
      serverId: grant?.serverId,
      audience: grant?.audience,
      keyId: grant?.keyId,
    });
  }

  return result;
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

function sendJson(socket: WebSocket, payload: JsonRecord) {
  socket.send(JSON.stringify(payload));
}

function closeHttpRelaySession(session: HttpRelaySession, reason = 'Relay HTTP session closed') {
  httpSessionStore.remove(session);
  const tunnel = tunnelRegistry.getByConnectionId(session.tunnelConnectionId);
  tunnelRegistry.removeSession(session.tunnelConnectionId, session.sessionId);

  closePendingHttpRelayRequests(session, reason);

  if (tunnel?.socket.readyState === WebSocket.OPEN) {
    const condition = classifyRelayCondition({
      source: reason.toLowerCase().includes('expired') ? 'session-attach' : 'close',
      closeReason: reason,
    });
    sendJson(tunnel.socket, {
      type: 'session-close',
      sessionId: session.sessionId,
      reason,
      relayCondition: condition.relayCondition,
      reasonCode: condition.reasonCode,
    });
  }
}

function closeExpiredHttpRelaySessions() {
  closeExpiredStoredHttpRelaySessions(httpSessionStore, closeHttpRelaySession);
}

function closeExistingRelaySession(sessionId: string) {
  const condition: RelayConditionResult = {
    relayCondition: 'degraded',
    reasonCode: 'control_plane_error',
    detail: 'Superseded by an idempotent relay attach retry',
  };
  closeSession(sessionId, 1012, condition.detail, condition);
  const httpSession = httpSessionStore.getBySessionId(sessionId);
  if (httpSession) closeHttpRelaySession(httpSession, condition.detail);
}

async function createHttpRelaySession(token: string): Promise<HttpRelaySession> {
  const attachment = await attachRelaySession({
    token,
    purpose: 'remote_http',
    relayControlPlane,
    tunnelRegistry,
    verifyGrantToken: verifyRelayGrantToken,
  });
  if (!attachment.ok) {
    throw new Error(attachment.condition.detail);
  }

  const consumedSession = attachment.consumedSession;
  const tunnel = attachment.tunnel;
  closeExistingRelaySession(consumedSession.sessionId);
  const session = createHttpRelaySessionRecord({
    handle: crypto.randomUUID(),
    consumedSession,
    tunnelConnectionId: tunnel.connectionId,
    ttlMs: RELAY_HTTP_SESSION_TTL_MS,
  });

  httpSessionStore.add(session);
  tunnelRegistry.addSession(tunnel.connectionId, session.sessionId);

  sendJson(tunnel.socket, {
    type: 'session-open',
    sessionId: session.sessionId,
    sessionType: session.sessionType,
    metadata: consumedSession.metadata ?? {},
  });

  relayLog('relay http session opened', {
    serverId: session.serverId,
    sessionId: session.sessionId,
    connectionId: tunnel.connectionId,
  });

  return session;
}

function findHttpSessionFromRequest(req: Request): HttpRelaySession | null {
  return findHttpRelaySessionFromCookie({
    cookieHeader: req.headers.cookie,
    cookieName: RELAY_HTTP_SESSION_COOKIE,
    store: httpSessionStore,
    onExpired: (session) => closeHttpRelaySession(session, 'Relay HTTP session expired'),
  });
}

async function forwardHttpRelayRequest(session: HttpRelaySession, req: Request, res: Response) {
  const tunnel = tunnelRegistry.getByConnectionId(session.tunnelConnectionId);
  if (!tunnel || tunnel.socket.readyState !== WebSocket.OPEN) {
    closeHttpRelaySession(session, 'Relay tunnel is unavailable');
    res.setHeader('Set-Cookie', clearRelaySessionCookie({
      cookieName: RELAY_HTTP_SESSION_COOKIE,
      secure: process.env.NODE_ENV === 'production',
    }));
    res.status(503).json({ error: 'Relay tunnel is unavailable' });
    return;
  }

  const requestId = openPendingHttpRelayRequest(session, res, {
    timeoutMs: RELAY_HTTP_REQUEST_TIMEOUT_MS,
    createRequestId: crypto.randomUUID,
  });

  try {
    const body = await readRelayHttpRequestBody(req, RELAY_HTTP_REQUEST_BODY_MAX_BYTES);
    sendJson(tunnel.socket, {
      type: 'session-frame',
      sessionId: session.sessionId,
      encoding: 'text',
      data: JSON.stringify({
        type: 'http-request',
        requestId,
        method: req.method,
        path: req.originalUrl || '/',
        headers: sanitizeRelayIncomingHeaders(req.headers, [RELAY_HTTP_SESSION_COOKIE]),
        bodyEncoding: body ? 'base64' : undefined,
        body: body ? body.toString('base64') : undefined,
      }),
    });
  } catch (error) {
    removePendingHttpRelayRequest(session, requestId);
    if (!res.headersSent) {
      res.status(413).json({
        error: error instanceof Error ? error.message : 'Relay HTTP request failed',
      });
    }
  }
}

function getOwnedHttpRelaySession(payload: JsonRecord, tunnel: TunnelConnection): HttpRelaySession | null {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
  const session = sessionId ? httpSessionStore.getBySessionId(sessionId) : null;
  if (!session) return null;
  if (session.tunnelConnectionId !== tunnel.connectionId) {
    relayWarn('relay rejected cross-tunnel http frame', {
      sessionId,
      expectedConnectionId: session.tunnelConnectionId,
      actualConnectionId: tunnel.connectionId,
      serverId: tunnel.serverId,
    });
    return null;
  }
  return session;
}

function handleHttpResponseStart(payload: JsonRecord, tunnel: TunnelConnection) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
  const session = getOwnedHttpRelaySession(payload, tunnel);
  const pending = requestId && session ? session.pendingRequests.get(requestId) : null;
  if (!session || !requestId || !pending || pending.response.headersSent) return;

  const result = startRelayHttpResponse(pending, {
    ...payload,
    protectedCookieNames: [RELAY_HTTP_SESSION_COOKIE],
  });
  if (!result.ok) {
    relayWarn('relay rejected malformed http response headers', {
      sessionId,
      requestId,
      error: result.error,
    });
    removePendingHttpRelayRequest(session, requestId);
    return;
  }
}

function handleHttpResponseBody(payload: JsonRecord, tunnel: TunnelConnection) {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
  const session = getOwnedHttpRelaySession(payload, tunnel);
  const pending = requestId && session ? session.pendingRequests.get(requestId) : null;
  if (!pending || pending.response.writableEnded) return;

  writeRelayHttpResponseBody(pending, payload);
}

function handleHttpResponseEnd(payload: JsonRecord, tunnel: TunnelConnection) {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
  const session = getOwnedHttpRelaySession(payload, tunnel);
  if (!session || !requestId) return;

  endPendingHttpRelayRequest(session, requestId);
}

function handleHttpResponseError(payload: JsonRecord, tunnel: TunnelConnection) {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
  const session = getOwnedHttpRelaySession(payload, tunnel);
  if (!session || !requestId) return;

  const message = typeof payload.message === 'string' ? payload.message : 'Relay HTTP request failed';
  failPendingHttpRelayRequest(session, requestId, message);
}

function closeSession(
  sessionId: string,
  code = 1011,
  fallback = 'Relay session closed',
  condition: RelayConditionResult = {
    relayCondition: 'degraded',
    reasonCode: 'session_attach_error',
    detail: 'Relay session closed',
  },
  expectedClientSocket?: WebSocket,
) {
  const session = sessionsById.get(sessionId);
  if (!session || (expectedClientSocket && session.clientSocket !== expectedClientSocket)) return;

  sessionsById.delete(sessionId);
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  const tunnel = tunnelRegistry.getByConnectionId(session.tunnelConnectionId);
  tunnelRegistry.removeSession(session.tunnelConnectionId, sessionId);

  const reason = toCloseReason(condition, fallback);

  if (session.clientSocket.readyState === WebSocket.OPEN || session.clientSocket.readyState === WebSocket.CONNECTING) {
    session.clientSocket.close(code, reason);
  }

  if (tunnel?.socket.readyState === WebSocket.OPEN) {
    sendJson(tunnel.socket, {
      type: 'session-close',
      sessionId,
      reason,
      relayCondition: condition.relayCondition,
      reasonCode: condition.reasonCode,
    });
  }

  relayWarn(
    'relay session close issued',
    addConditionMetadata(condition, {
      sessionId,
      serverId: session.serverId,
      connectionId: session.tunnelConnectionId,
      closeCode: code,
    }),
  );
}

function dropTunnel(connectionId: string, condition: RelayConditionResult): void {
  const tunnel = tunnelRegistry.getByConnectionId(connectionId);
  if (!tunnel) return;

  tunnelRegistry.removeByConnectionId(connectionId);

  for (const sessionId of Array.from(tunnel.sessions)) {
    closeSession(sessionId, 1011, toCloseReason(condition, 'Relay tunnel dropped'), condition);
    const httpSession = httpSessionStore.getBySessionId(sessionId);
    if (httpSession) {
      closeHttpRelaySession(httpSession, 'Relay tunnel dropped');
    }
  }
}

function handleRelayHeartbeatFailure(
  tunnel: TunnelConnection,
  response: { status: number; error?: string },
): RelayConditionResult {
  const result = classifyRelayCondition({
    source: 'heartbeat',
    status: response.status,
    error: response.error,
  });

  relayWarn(
    'relay heartbeat failed',
    addConditionMetadata(result, {
      serverId: tunnel.serverId,
      connectionId: tunnel.connectionId,
      status: response.status,
      error: response.error,
    }),
  );

  return result;
}

async function registerTunnel(socket: WebSocket, token: string, payload: JsonRecord) {
  const protocolVersion = Number(payload.protocolVersion);
  if (!Number.isFinite(protocolVersion)) {
    const condition: RelayConditionResult = {
      relayCondition: 'degraded',
      reasonCode: 'invalid_register_payload',
      detail: 'protocolVersion is required',
    };

    sendJson(socket, {
      type: 'error',
      code: 'INVALID_REGISTER',
      message: condition.detail,
      relayCondition: condition.relayCondition,
      reasonCode: condition.reasonCode,
    });
    socket.close(1008, toCloseReason(condition, condition.detail));
    return;
  }

  const connectionId = crypto.randomUUID();
  const response = await relayControlPlane.registerRelayConnection(token, {
    connectionId,
    protocolVersion,
    region: typeof payload.region === 'string' ? payload.region : undefined,
    clientVersion: typeof payload.clientVersion === 'string' ? payload.clientVersion : undefined,
    capabilities: typeof payload.capabilities === 'object' && payload.capabilities ? payload.capabilities : {},
    metadata: typeof payload.metadata === 'object' && payload.metadata ? payload.metadata : {},
  });

  const condition = response.ok
    ? ({ relayCondition: 'connected' as const, reasonCode: 'ok' as const, detail: 'register ok' } as RelayConditionResult)
    : classifyRelayCondition({
        source: 'register',
        status: response.status,
        error: response.error,
      });

  if (!response.ok) {
    sendJson(socket, {
      type: 'error',
      code: 'REGISTER_FAILED',
      message: condition.detail,
      relayCondition: condition.relayCondition,
      reasonCode: condition.reasonCode,
    });
    socket.close(1011, toCloseReason(condition, 'Relay registration failed'));
    relayWarn('relay tunnel register failed',
      addConditionMetadata(condition, {
        status: response.status,
        error: response.error,
      }));
    return;
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

  const existing = tunnelRegistry.register(tunnel);
  if (existing) {
    const superseded = {
      relayCondition: 'degraded' as const,
      reasonCode: 'control_plane_error' as const,
      detail: 'Superseded by a newer tunnel',
    } satisfies RelayConditionResult;
    dropTunnel(existing.connectionId, superseded);
    if (existing.socket.readyState === WebSocket.OPEN || existing.socket.readyState === WebSocket.CONNECTING) {
      existing.socket.close(1012, toCloseReason(superseded, 'Superseded by a newer tunnel'));
    }
  }

  sendJson(socket, {
    type: 'registered',
    serverId: tunnel.serverId,
    connectionId,
    heartbeatIntervalSeconds: response.data.heartbeatIntervalSeconds,
    relaySessionTtlSeconds: response.data.relaySessionTtlSeconds,
  });

  relayLog(
    'relay tunnel registered',
    addConditionMetadata(condition, {
      serverId: tunnel.serverId,
      connectionId,
      protocolVersion,
    }),
  );
}

async function handleTunnelHeartbeat(tunnel: TunnelConnection, payload: JsonRecord): Promise<RelayConditionResult> {
  const outgoingCondition: RelayConditionResult = {
    relayCondition: 'connected',
    reasonCode: 'ok',
    detail: 'heartbeat ok',
  };

  const response = await relayControlPlane.recordRelayHeartbeat(tunnel.token, {
    connectionId: tunnel.connectionId,
    sessionIds: Array.from(tunnel.sessions),
    relayStatus: relayStatusForControlPlane(outgoingCondition.relayCondition),
    relayCondition: outgoingCondition.relayCondition,
    reasonCode: outgoingCondition.reasonCode,
    protocolVersion: typeof payload.protocolVersion === 'number' ? payload.protocolVersion : tunnel.protocolVersion,
    region: typeof payload.region === 'string' ? payload.region : tunnel.region,
    clientVersion: typeof payload.clientVersion === 'string' ? payload.clientVersion : tunnel.clientVersion,
    capabilities: typeof payload.capabilities === 'object' && payload.capabilities ? payload.capabilities : tunnel.capabilities ?? {},
    metadata: typeof payload.metadata === 'object' && payload.metadata ? payload.metadata : {},
  });

  if (!response.ok) {
    return handleRelayHeartbeatFailure(tunnel, response);
  }

  for (const terminalSession of response.data?.terminalSessions ?? []) {
    const sessionId = typeof terminalSession.sessionId === 'string' ? terminalSession.sessionId : '';
    const status = typeof terminalSession.status === 'string' ? terminalSession.status : 'revoked';
    if (!sessionId || !tunnel.sessions.has(sessionId)) {
      continue;
    }

    const condition: RelayConditionResult = status === 'expired'
      ? {
          relayCondition: 'expired',
          reasonCode: 'token_expired',
          detail: 'Relay session expired',
        }
      : {
          relayCondition: 'revoked',
          reasonCode: 'token_revoked',
          detail: 'Relay session revoked',
        };
    const wsSession = sessionsById.get(sessionId);
    if (wsSession?.tunnelConnectionId === tunnel.connectionId) {
      closeSession(sessionId, 4401, condition.detail, condition);
      continue;
    }

    const httpSession = httpSessionStore.getBySessionId(sessionId);
    if (httpSession?.tunnelConnectionId === tunnel.connectionId) {
      closeHttpRelaySession(httpSession, condition.detail);
    }
  }

  return outgoingCondition;
}

async function attachClientSession(clientSocket: WebSocket, token: string) {
  const attachment = await attachRelaySession({
    token,
    purpose: 'remote_ws',
    relayControlPlane,
    tunnelRegistry,
    verifyGrantToken: verifyRelayGrantToken,
  });

  if (!attachment.ok) {
    const logMessage = attachment.stage === 'grant'
      ? 'relay client session grant rejected'
      : attachment.stage === 'purpose'
        ? 'relay client session grant purpose rejected'
        : attachment.stage === 'binding'
          ? 'relay client session grant binding rejected'
          : attachment.stage === 'tunnel'
            ? 'relay client session attach failed - no tunnel'
            : 'relay client session attach failed';

    relayWarn(
      logMessage,
      addConditionMetadata(attachment.condition, {
        ...(attachment.error ? { error: attachment.error } : {}),
        ...(attachment.grant ? {
          grantId: attachment.grant.grantId,
          grantServerId: attachment.grant.serverId,
          grantSubjectAccountId: attachment.grant.subjectAccountId,
          purpose: attachment.grant.purpose,
        } : {}),
      }),
    );
    clientSocket.close(
      attachment.stage === 'tunnel' ? 4404 : 4401,
      toCloseReason(
        attachment.condition,
        attachment.stage === 'grant' ? 'Invalid relay grant' : attachment.condition.detail,
      ),
    );
    return;
  }

  const consumedSession = attachment.consumedSession;
  const tunnel = attachment.tunnel;
  closeExistingRelaySession(consumedSession.sessionId);
  const cloudExpiresAt = consumedSession.expiresAt ? Date.parse(consumedSession.expiresAt) : NaN;
  const session: RelaySession = {
    sessionId: consumedSession.sessionId,
    serverId: consumedSession.serverId,
    userId: consumedSession.userId,
    sessionType: consumedSession.sessionType,
    clientSocket,
    tunnelConnectionId: tunnel.connectionId,
    openedAt: new Date().toISOString(),
    expiresAt: Number.isFinite(cloudExpiresAt) ? cloudExpiresAt : Date.now() + RELAY_HTTP_SESSION_TTL_MS,
  };
  session.expiryTimer = setTimeout(() => {
    const condition: RelayConditionResult = {
      relayCondition: 'expired',
      reasonCode: 'token_expired',
      detail: 'Relay session expired',
    };
    closeSession(session.sessionId, 4401, condition.detail, condition, session.clientSocket);
  }, Math.max(1, session.expiresAt - Date.now()));

  sessionsById.set(session.sessionId, session);
  tunnelRegistry.addSession(tunnel.connectionId, session.sessionId);

  sendJson(tunnel.socket, {
    type: 'session-open',
    sessionId: session.sessionId,
    sessionType: session.sessionType,
    metadata: consumedSession.metadata ?? {},
  });

  sendJson(clientSocket, {
    type: 'session-ready',
    sessionId: session.sessionId,
    serverId: session.serverId,
  });

  relayLog(
    'relay session attached',
    addConditionMetadata(attachment.condition, {
      serverId: session.serverId,
      sessionId: session.sessionId,
      connectionId: tunnel.connectionId,
    }),
  );

  clientSocket.on('message', (raw, isBinary) => {
    if (tunnel.socket.readyState !== WebSocket.OPEN) {
      const condition: RelayConditionResult = {
        relayCondition: 'unreachable',
        reasonCode: 'tunnel_missing',
        detail: 'Relay tunnel is not available',
      };
      closeSession(session.sessionId, 1011, 'Relay tunnel is not available', condition, clientSocket);
      return;
    }

    try {
      sendJson(tunnel.socket, {
        type: 'session-frame',
        sessionId: session.sessionId,
        encoding: isBinary ? 'base64' : 'text',
        data: isBinary ? rawDataToBuffer(raw).toString('base64') : rawDataToString(raw),
      });
    } catch {
      const condition: RelayConditionResult = {
        relayCondition: 'degraded',
        reasonCode: 'frame_forwarding_error',
        detail: 'Failed to forward frame',
      };
      closeSession(session.sessionId, 1011, 'Frame forwarding failed', condition, clientSocket);
    }
  });

  clientSocket.on('close', () => {
    const condition: RelayConditionResult = {
      relayCondition: 'degraded',
      reasonCode: 'client_socket_error',
      detail: 'Client disconnected',
    };
    closeSession(session.sessionId, 1000, 'Client disconnected', condition, clientSocket);
  });

  clientSocket.on('error', () => {
    const condition: RelayConditionResult = {
      relayCondition: 'degraded',
      reasonCode: 'client_socket_error',
      detail: 'Client socket error',
    };
    closeSession(session.sessionId, 1011, 'Client socket error', condition, clientSocket);
  });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get(['/health', '/healthz'], (_req, res) => {
  res.json({ ok: true });
});

app.get(/^\/r\/([^/]+)(\/.*)?$/, async (req, res) => {
  const match = req.path.match(/^\/r\/([^/]+)(\/.*)?$/);
  const token = match?.[1];
  const pathAfterToken = match?.[2] || '/';
  if (!token) {
    res.status(400).json({ error: 'Relay session token is required' });
    return;
  }

  try {
    const session = await createHttpRelaySession(decodeURIComponent(token));
    res.setHeader('Set-Cookie', relaySessionCookie({
      cookieName: RELAY_HTTP_SESSION_COOKIE,
      handle: session.handle,
      maxAgeSeconds: relaySessionMaxAgeSeconds(session.expiresAt),
      secure: process.env.NODE_ENV === 'production',
    }));
    res.redirect(302, relayHandoffRedirectTarget(req.originalUrl, pathAfterToken));
  } catch (error) {
    res.setHeader('Set-Cookie', clearRelaySessionCookie({
      cookieName: RELAY_HTTP_SESSION_COOKIE,
      secure: process.env.NODE_ENV === 'production',
    }));
    res.status(409).json({
      error: error instanceof Error ? error.message : 'Unable to open relay session',
    });
  }
});

app.use((req, res, next) => {
  const session = findHttpSessionFromRequest(req);
  if (!session) {
    next();
    return;
  }

  forwardHttpRelayRequest(session, req, res).catch((error) => {
    if (!res.headersSent) {
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Relay HTTP request failed',
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

const server = createServer(app);
const tunnelWss = new WebSocketServer({ noServer: true });
const sessionWss = new WebSocketServer({ noServer: true });

tunnelWss.on('connection', (socket, req) => {
  const token = getBearerToken(req);
  if (!token) {
    const condition: RelayConditionResult = {
      relayCondition: 'unauthorized',
      reasonCode: 'auth_invalid',
      detail: 'Missing relay tunnel token',
    };
    socket.close(4401, toCloseReason(condition, 'Missing relay tunnel token'));
    return;
  }

  let tunnelConnectionId: string | null = null;

  const heartbeatTimer = setInterval(async () => {
    if (!tunnelConnectionId) return;
    const tunnel = tunnelRegistry.getByConnectionId(tunnelConnectionId);
    if (!tunnel) return;
    const condition = await handleTunnelHeartbeat(tunnel, {});
    if (condition.relayCondition !== 'connected') {
      relayWarn(
        'relay heartbeat condition',
        addConditionMetadata(condition, {
          serverId: tunnel.serverId,
          connectionId: tunnel.connectionId,
        }),
      );
      if (isTerminalRelayCondition(condition.relayCondition)) {
        dropTunnel(tunnel.connectionId, condition);
        if (tunnel.socket.readyState === WebSocket.OPEN || tunnel.socket.readyState === WebSocket.CONNECTING) {
          tunnel.socket.close(4401, toCloseReason(condition, 'Relay tunnel authorization ended'));
        }
      }
    }
  }, RELAY_HEARTBEAT_INTERVAL_MS);

  socket.on('message', async (raw) => {
    const payload = parseJson(raw);
    if (!payload || typeof payload.type !== 'string') {
      sendJson(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Expected JSON message with type' });
      return;
    }

    if (payload.type === 'register') {
      await registerTunnel(socket, token, payload);
      const registered = tunnelRegistry.findBySocket(socket);
      tunnelConnectionId = registered?.connectionId ?? null;
      return;
    }

    if (!tunnelConnectionId) {
      sendJson(socket, { type: 'error', code: 'NOT_REGISTERED', message: 'Tunnel must register before sending frames' });
      return;
    }

    const tunnel = tunnelRegistry.getByConnectionId(tunnelConnectionId);
    if (!tunnel) {
      sendJson(socket, { type: 'error', code: 'UNKNOWN_TUNNEL', message: 'Relay tunnel is not active' });
      return;
    }

    switch (payload.type) {
      case 'heartbeat': {
        const condition = await handleTunnelHeartbeat(tunnel, payload);
        sendJson(socket, {
          type: 'heartbeat-ack',
          connectionId: tunnel.connectionId,
          receivedAt: new Date().toISOString(),
          relayCondition: condition.relayCondition,
          reasonCode: condition.reasonCode,
        });
        if (isTerminalRelayCondition(condition.relayCondition)) {
          dropTunnel(tunnel.connectionId, condition);
          socket.close(4401, toCloseReason(condition, 'Relay tunnel authorization ended'));
        }
        break;
      }
      case 'session-frame': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
        const session = sessionId ? sessionsById.get(sessionId) : null;
        if (!session) return;
        if (session.tunnelConnectionId !== tunnel.connectionId) {
          relayWarn('relay rejected cross-tunnel session frame', {
            sessionId,
            expectedConnectionId: session.tunnelConnectionId,
            actualConnectionId: tunnel.connectionId,
            serverId: tunnel.serverId,
          });
          return;
        }
        if (session.clientSocket.readyState !== WebSocket.OPEN) {
          const condition: RelayConditionResult = {
            relayCondition: 'degraded',
            reasonCode: 'frame_forwarding_error',
            detail: 'Client socket no longer open',
          };
          closeSession(session.sessionId, 1000, 'Client socket no longer open', condition);
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
      case 'session-ready':
        break;
      case 'session-close': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
        if (!sessionId) break;
        const httpSession = httpSessionStore.getBySessionId(sessionId);
        if (httpSession) {
          if (httpSession.tunnelConnectionId !== tunnel.connectionId) {
            relayWarn('relay rejected cross-tunnel http session close', {
              sessionId,
              expectedConnectionId: httpSession.tunnelConnectionId,
              actualConnectionId: tunnel.connectionId,
              serverId: tunnel.serverId,
            });
            break;
          }
          closeHttpRelaySession(
            httpSession,
            typeof payload.reason === 'string' ? payload.reason : 'Session closed by server',
          );
          break;
        }
        const session = sessionsById.get(sessionId);
        if (session && session.tunnelConnectionId !== tunnel.connectionId) {
          relayWarn('relay rejected cross-tunnel session close', {
            sessionId,
            expectedConnectionId: session.tunnelConnectionId,
            actualConnectionId: tunnel.connectionId,
            serverId: tunnel.serverId,
          });
          break;
        }
        const condition: RelayConditionResult = {
          relayCondition: 'degraded',
          reasonCode: 'session_attach_error',
          detail: typeof payload.reason === 'string' ? payload.reason : 'Session closed by server',
        };
        closeSession(sessionId, 1000, condition.detail, condition);
        break;
      }
      case 'http-response-start':
        handleHttpResponseStart(payload, tunnel);
        break;
      case 'http-response-body':
        handleHttpResponseBody(payload, tunnel);
        break;
      case 'http-response-end':
        handleHttpResponseEnd(payload, tunnel);
        break;
      case 'http-response-error':
        handleHttpResponseError(payload, tunnel);
        break;
      default:
        sendJson(socket, {
          type: 'error',
          code: 'UNKNOWN_TYPE',
          message: `Unknown tunnel message type: ${payload.type}`,
        });
    }
  });

  socket.on('close', (code, reasonBuffer) => {
    clearInterval(heartbeatTimer);
    if (!tunnelConnectionId) return;

    const closeReason = reasonBuffer?.toString();
    const condition = classifyRelayCondition({
      source: 'close',
      closeReason,
    });

    relayWarn(
      'relay tunnel disconnected',
      addConditionMetadata(condition, {
        connectionId: tunnelConnectionId,
        closeCode: code,
      }),
    );
    dropTunnel(tunnelConnectionId, condition);
  });

  socket.on('error', (error) => {
    const condition = classifyRelayCondition({
      source: 'socket-error',
      error: error instanceof Error ? error.message : 'Unknown websocket error',
    });
    if (tunnelConnectionId) {
      relayError(
        'relay tunnel socket error',
        addConditionMetadata(condition, {
          connectionId: tunnelConnectionId,
        }),
      );
    } else {
      relayError('relay tunnel socket error', {
        error: error instanceof Error ? error.message : 'Unknown websocket error',
        relayCondition: condition.relayCondition,
        reasonCode: condition.reasonCode,
      });
    }
  });
});

sessionWss.on('connection', (socket, req) => {
  const token = getBearerToken(req);
  if (!token) {
    const condition: RelayConditionResult = {
      relayCondition: 'unauthorized',
      reasonCode: 'auth_invalid',
      detail: 'Missing relay session token',
    };
    socket.close(4401, toCloseReason(condition, 'Missing relay session token'));
    return;
  }

  attachClientSession(socket, token).catch((error) => {
    const condition: RelayConditionResult = {
      relayCondition: 'degraded',
      reasonCode: 'session_attach_error',
      detail: error instanceof Error ? error.message : 'Unknown session attach error',
    };
    relayError('relay client session attach failed',
      addConditionMetadata(condition, {
        error: condition.detail,
      }));
    socket.close(1011, toCloseReason(condition, 'Relay session attach failed'));
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

setInterval(closeExpiredHttpRelaySessions, Math.min(RELAY_HTTP_SESSION_TTL_MS, 60_000));
