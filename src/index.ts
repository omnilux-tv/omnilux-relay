import 'dotenv/config';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

type JsonRecord = Record<string, unknown>;

type RelayCondition = 'connected' | 'degraded' | 'unauthorized' | 'expired' | 'revoked' | 'unreachable';
type RelayReasonCode =
  | 'ok'
  | 'auth_invalid'
  | 'token_expired'
  | 'token_revoked'
  | 'control_plane_unreachable'
  | 'control_plane_error'
  | 'tunnel_missing'
  | 'session_attach_error'
  | 'client_socket_error'
  | 'frame_forwarding_error'
  | 'socket_error'
  | 'invalid_register_payload';

interface RelayConditionResult {
  relayCondition: RelayCondition;
  reasonCode: RelayReasonCode;
  detail: string;
}

interface RelayConditionEvidence {
  source: 'register' | 'heartbeat' | 'session-attach' | 'close' | 'socket-error';
  status?: number;
  error?: string;
  closeReason?: string;
  hasActiveTunnel?: boolean;
  code?: number;
}

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

interface RelayGrant {
  version: string;
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
  signature: string;
}

const RELAY_GRANT_TOKEN_PREFIX = 'olrg_';

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
const RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL = process.env.RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL?.trim() ?? '';
const RELAY_GRANT_AUDIENCE = process.env.RELAY_GRANT_AUDIENCE?.trim() || 'relay.omnilux.tv';
const RELAY_REQUIRE_SIGNED_SESSION_GRANTS = process.env.RELAY_REQUIRE_SIGNED_SESSION_GRANTS === 'true';
const RELAY_GRANT_MAX_CLOCK_SKEW_MS = Number(process.env.RELAY_GRANT_MAX_CLOCK_SKEW_MS ?? 30_000);

const tunnelsByServerId = new Map<string, TunnelConnection>();
const tunnelsByConnectionId = new Map<string, TunnelConnection>();
const sessionsById = new Map<string, RelaySession>();

function normalizeLower(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function hasAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function classifyRelayCondition(evidence: RelayConditionEvidence): RelayConditionResult {
  const status = evidence.status;
  const lowerError = normalizeLower(evidence.error);
  const lowerReason = normalizeLower(evidence.closeReason);

  const revokedTerms = ['revoked', 'token revoked', 'credential revoked', 'revocation', 'invalidated'];
  const expiredTerms = ['expired', 'expiry', 'token expired', 'session expired', 'jwt expired'];
  const authTerms = ['unauthorized', 'forbidden', 'invalid bearer', 'invalid token', 'missing token', 'authentication', 'auth'];
  const unreachableTerms = ['failed to fetch', 'fetch', 'timeout', 'econnrefused', 'network', 'enotfound', 'dns'];

  const message = `${lowerError} ${lowerReason}`;

  if (evidence.hasActiveTunnel === false) {
    return {
      relayCondition: 'unreachable',
      reasonCode: 'tunnel_missing',
      detail: evidence.error ?? evidence.closeReason ?? 'No active relay tunnel for this server',
    };
  }

  if (hasAny(message, revokedTerms)) {
    return {
      relayCondition: 'revoked',
      reasonCode: 'token_revoked',
      detail: evidence.error ?? evidence.closeReason ?? 'credential revoked',
    };
  }

  if (hasAny(message, expiredTerms)) {
    return {
      relayCondition: 'expired',
      reasonCode: 'token_expired',
      detail: evidence.error ?? evidence.closeReason ?? 'token expired',
    };
  }

  if (status === 401 || status === 403 || hasAny(message, authTerms)) {
    return {
      relayCondition: 'unauthorized',
      reasonCode: 'auth_invalid',
      detail: evidence.error ?? evidence.closeReason ?? 'authentication/authorization rejected',
    };
  }

  if (status === 410 || status === 419) {
    return {
      relayCondition: 'expired',
      reasonCode: 'token_expired',
      detail: evidence.error ?? 'token/session expired',
    };
  }

  if (evidence.source === 'socket-error' || evidence.source === 'close') {
    return {
      relayCondition: 'degraded',
      reasonCode: 'socket_error',
      detail: evidence.error ?? evidence.closeReason ?? 'transport/socket error',
    };
  }

  if ((status !== undefined && status >= 500) || status === 0 || hasAny(message, unreachableTerms)) {
    return {
      relayCondition: 'unreachable',
      reasonCode: 'control_plane_unreachable',
      detail: evidence.error ?? evidence.closeReason ?? 'control plane unreachable',
    };
  }

  if (status !== undefined) {
    return {
      relayCondition: 'degraded',
      reasonCode: status >= 400 ? 'control_plane_error' : 'ok',
      detail: evidence.error ?? 'control-plane returned non-success',
    };
  }

  return {
    relayCondition: 'connected',
    reasonCode: 'ok',
    detail: 'ok',
  };
}

function relayStatusForControlPlane(condition: RelayCondition): string {
  return condition === 'connected' ? 'online' : 'degraded';
}

function toCloseReason(condition: RelayConditionResult, fallback: string): string {
  return `Relay condition ${condition.relayCondition} (${condition.reasonCode}): ${condition.detail}`;
}

function addConditionMetadata(condition: RelayConditionResult, extra: JsonRecord): JsonRecord {
  return {
    relayCondition: condition.relayCondition,
    reasonCode: condition.reasonCode,
    ...extra,
  };
}

function getBearerToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice(7).trim();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function base64UrlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRelayGrant(value: unknown): value is RelayGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Record<string, unknown>;
  return typeof grant.version === 'string'
    && typeof grant.grantId === 'string'
    && typeof grant.serverId === 'string'
    && typeof grant.ownerAccountId === 'string'
    && typeof grant.subjectAccountId === 'string'
    && typeof grant.audience === 'string'
    && ['remote_http', 'remote_ws', 'diagnostic'].includes(String(grant.purpose))
    && isStringArray(grant.scope)
    && typeof grant.issuedAt === 'string'
    && typeof grant.expiresAt === 'string'
    && typeof grant.sessionLimit === 'number'
    && typeof grant.entitlementLeaseId === 'string'
    && typeof grant.issuer === 'string'
    && typeof grant.keyId === 'string'
    && grant.signatureAlgorithm === 'ed25519'
    && typeof grant.signature === 'string';
}

function parseSignedRelayGrantToken(token: string): RelayGrant | null {
  if (!token.startsWith(RELAY_GRANT_TOKEN_PREFIX)) return null;
  try {
    const decoded = new TextDecoder().decode(base64UrlToBytes(token.slice(RELAY_GRANT_TOKEN_PREFIX.length)));
    const parsed = JSON.parse(decoded) as unknown;
    return isRelayGrant(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function importRelayGrantPublicKey(): Promise<CryptoKey | null> {
  if (!RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL) return null;
  return crypto.subtle.importKey(
    'spki',
    base64UrlToBytes(RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL),
    'Ed25519',
    false,
    ['verify'],
  );
}

async function verifyRelayGrantToken(token: string): Promise<{
  ok: true;
  grant?: RelayGrant;
} | {
  ok: false;
  condition: RelayConditionResult;
}> {
  if (!token.startsWith(RELAY_GRANT_TOKEN_PREFIX)) {
    if (!RELAY_REQUIRE_SIGNED_SESSION_GRANTS) {
      return { ok: true };
    }
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Signed relay session grant is required',
      },
    };
  }

  const grant = parseSignedRelayGrantToken(token);
  if (!grant) {
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Invalid relay grant format',
      },
    };
  }

  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Invalid relay grant timestamps',
      },
    };
  }
  if (expiresAt <= now) {
    return {
      ok: false,
      condition: {
        relayCondition: 'expired',
        reasonCode: 'token_expired',
        detail: 'Relay grant has expired',
      },
    };
  }
  if (issuedAt - now > RELAY_GRANT_MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Relay grant is not valid yet',
      },
    };
  }
  if (grant.audience !== RELAY_GRANT_AUDIENCE) {
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Relay grant audience mismatch',
      },
    };
  }
  if (grant.sessionLimit !== 1) {
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Relay grant session limit must be exactly one',
      },
    };
  }
  if (!grant.scope.includes('relay:session:connect')) {
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Relay grant scope does not allow session attachment',
      },
    };
  }

  const publicKey = await importRelayGrantPublicKey();
  if (!publicKey) {
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Relay grant verification key is not configured',
      },
    };
  }

  const { signature, ...payload } = grant;
  const signatureValid = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    base64UrlToBytes(signature),
    new TextEncoder().encode(stableStringify(payload)),
  );

  if (!signatureValid) {
    relayWarn('relay grant signature rejected', {
      grantId: grant.grantId,
      serverId: grant.serverId,
      audience: grant.audience,
      keyId: grant.keyId,
    });
    return {
      ok: false,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Relay grant signature is invalid',
      },
    };
  }

  return { ok: true, grant };
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
      status: 0,
      error: error instanceof Error ? error.message : 'Unknown relay control-plane error',
    };
  }
}

function sendJson(socket: WebSocket, payload: JsonRecord) {
  socket.send(JSON.stringify(payload));
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
) {
  const session = sessionsById.get(sessionId);
  if (!session) return;

  sessionsById.delete(sessionId);
  const tunnel = tunnelsByConnectionId.get(session.tunnelConnectionId);
  tunnel?.sessions.delete(sessionId);

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
  const tunnel = tunnelsByConnectionId.get(connectionId);
  if (!tunnel) return;

  tunnelsByConnectionId.delete(connectionId);
  if (tunnelsByServerId.get(tunnel.serverId)?.connectionId === connectionId) {
    tunnelsByServerId.delete(tunnel.serverId);
  }

  for (const sessionId of Array.from(tunnel.sessions)) {
    closeSession(sessionId, 1011, toCloseReason(condition, 'Relay tunnel dropped'), condition);
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

  const condition = response.ok
    ? ({ relayCondition: 'connected' as const, reasonCode: 'ok' as const, detail: 'register ok' } as RelayConditionResult)
    : classifyRelayCondition({
        source: 'register',
        status: response.status,
        error: response.error,
      });

  if (!response.ok || !response.data) {
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

  const existing = tunnelsByServerId.get(response.data.serverId);
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

  const response = await postControlPlane<{ ok: boolean }>('relay-heartbeat', tunnel.token, {
    connectionId: tunnel.connectionId,
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

  return outgoingCondition;
}

async function attachClientSession(clientSocket: WebSocket, token: string) {
  const connectionId = crypto.randomUUID();
  const grantVerification = await verifyRelayGrantToken(token);
  if (!grantVerification.ok) {
    relayWarn('relay client session grant rejected',
      addConditionMetadata(grantVerification.condition, {}));
    clientSocket.close(4401, toCloseReason(grantVerification.condition, 'Invalid relay grant'));
    return;
  }

  const response = await postControlPlane<{
    sessionId: string;
    serverId: string;
    userId?: string;
    sessionType: string;
    metadata?: Record<string, unknown>;
  }>('consume-relay-session', token, { connectionId });

  const consumeCondition = response.ok
    ? { relayCondition: 'connected' as const, reasonCode: 'ok' as const, detail: 'consume ok' } as RelayConditionResult
    : classifyRelayCondition({
        source: 'session-attach',
        status: response.status,
        error: response.error,
      });

  if (!response.ok || !response.data) {
    relayWarn('relay client session attach failed',
      addConditionMetadata(consumeCondition, {
        error: response.error,
      }));
    clientSocket.close(4401, toCloseReason(consumeCondition, 'Invalid relay session'));
    return;
  }

  if (grantVerification.grant) {
    const grant = grantVerification.grant;
    if (response.data.serverId !== grant.serverId || response.data.userId !== grant.subjectAccountId) {
      const condition: RelayConditionResult = {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: 'Relay grant does not match consumed session',
      };
      relayWarn('relay client session grant binding rejected',
        addConditionMetadata(condition, {
          grantId: grant.grantId,
          grantServerId: grant.serverId,
          sessionServerId: response.data.serverId,
          grantSubjectAccountId: grant.subjectAccountId,
          sessionUserId: response.data.userId,
        }));
      clientSocket.close(4401, toCloseReason(condition, condition.detail));
      return;
    }
  }

  const tunnel = tunnelsByServerId.get(response.data.serverId);
  if (!tunnel) {
    const condition: RelayConditionResult = {
      relayCondition: 'unreachable',
      reasonCode: 'tunnel_missing',
      detail: 'No active relay tunnel for this server',
    };
    relayWarn('relay client session attach failed - no tunnel',
      addConditionMetadata(condition, {
        serverId: response.data.serverId,
      }));
    clientSocket.close(4404, toCloseReason(condition, condition.detail));
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

  relayLog(
    'relay session attached',
    addConditionMetadata(consumeCondition, {
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
      closeSession(session.sessionId, 1011, 'Relay tunnel is not available', condition);
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
      closeSession(session.sessionId, 1011, 'Frame forwarding failed', condition);
    }
  });

  clientSocket.on('close', () => {
    const condition: RelayConditionResult = {
      relayCondition: 'degraded',
      reasonCode: 'client_socket_error',
      detail: 'Client disconnected',
    };
    closeSession(session.sessionId, 1000, 'Client disconnected', condition);
  });

  clientSocket.on('error', () => {
    const condition: RelayConditionResult = {
      relayCondition: 'degraded',
      reasonCode: 'client_socket_error',
      detail: 'Client socket error',
    };
    closeSession(session.sessionId, 1011, 'Client socket error', condition);
  });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get(['/health', '/healthz'], (_req, res) => {
  res.json({ ok: true });
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
    const tunnel = tunnelsByConnectionId.get(tunnelConnectionId);
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
      case 'heartbeat': {
        const condition = await handleTunnelHeartbeat(tunnel, payload);
        sendJson(socket, {
          type: 'heartbeat-ack',
          connectionId: tunnel.connectionId,
          receivedAt: new Date().toISOString(),
          relayCondition: condition.relayCondition,
          reasonCode: condition.reasonCode,
        });
        break;
      }
      case 'session-frame': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
        const session = sessionId ? sessionsById.get(sessionId) : null;
        if (!session) return;
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
      case 'session-close': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
        if (!sessionId) break;
        const condition: RelayConditionResult = {
          relayCondition: 'degraded',
          reasonCode: 'session_attach_error',
          detail: typeof payload.reason === 'string' ? payload.reason : 'Session closed by server',
        };
        closeSession(sessionId, 1000, condition.detail, condition);
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
