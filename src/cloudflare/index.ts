import {
  classifyRelayCondition,
  isTerminalRelayCondition,
  relayStatusForControlPlane,
  toCloseReason,
  type JsonRecord,
  type RelayConditionResult,
} from '../relay-condition.js';
import {
  createRelayControlPlaneClient,
  type ConsumedRelaySession,
  type RelayControlPlaneClient,
} from '../relay-control-plane.js';
import {
  deriveRelayAttachAttemptId,
  deriveRelaySessionConnectionId,
} from '../relay-attach-attempt.js';
import {
  parseSignedRelayGrantToken,
  validateRelayGrantPublicKey,
  validateRelayGrantSessionBinding,
  verifyRelayGrantToken,
  type RelayGrant,
  type RelayGrantVerificationResult,
} from './relay-grant.js';

export interface Env {
  RELAY_COORDINATOR: DurableObjectNamespace;
  RELAY_RENDEZVOUS: DurableObjectNamespace;
  RELAY_LEGACY_COORDINATOR_NAME?: string;
  RELAY_RENDEZVOUS_NAME?: string;
  RELAY_RENDEZVOUS_PARTITIONS?: string;
  RELAY_RENDEZVOUS_TTL_MS?: string;
  RELAY_CONTROL_URL?: string;
  RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL?: string;
  RELAY_GRANT_AUDIENCE?: string;
  RELAY_ALLOW_LEGACY_SESSION_GRANTS?: string;
  RELAY_GRANT_MAX_CLOCK_SKEW_MS?: string;
  RELAY_GRANT_MAX_TTL_MS?: string;
  RELAY_HTTP_SESSION_COOKIE?: string;
  RELAY_HTTP_SESSION_TTL_MS?: string;
  RELAY_HTTP_REQUEST_TIMEOUT_MS?: string;
  RELAY_HTTP_REQUEST_BODY_MAX_BYTES?: string;
  RELAY_HTTP_RESPONSE_BUFFER_MAX_BYTES?: string;
  RELAY_HTTP_COOKIE_SECURE?: string;
  RELAY_REGION?: string;
}

type RelaySessionAttachmentPurpose = 'remote_ws' | 'remote_http';
type RelaySessionAttachmentFailureStage = 'grant' | 'purpose' | 'consume' | 'binding' | 'tunnel';

type RelaySessionAttachmentResult =
  | {
      ok: true;
      connectionId: string;
      condition: RelayConditionResult;
      consumedSession: ConsumedRelaySession;
      tunnel: DurableTunnel;
      grant?: RelayGrant;
    }
  | {
      ok: false;
      connectionId: string;
      condition: RelayConditionResult;
      stage: RelaySessionAttachmentFailureStage;
      grant?: RelayGrant;
      status?: number;
      error?: string;
    };

interface TunnelAttachment {
  role: 'tunnel';
  token: string;
  registered: boolean;
  serverId?: string;
  connectionId?: string;
  registeredAt?: string;
  protocolVersion?: number;
  region?: string;
  clientVersion?: string;
  capabilities?: JsonRecord;
  shardKey: string;
  acceptedAt?: number;
}

interface ClientSessionAttachment {
  role: 'session';
  sessionId: string;
  serverId: string;
  userId?: string;
  sessionType: string;
  tunnelConnectionId: string;
  openedAt: string;
  expiresAt: number;
  closedByRelay?: boolean;
}

type SocketAttachment = TunnelAttachment | ClientSessionAttachment;

interface DurableTunnel {
  socket: WebSocket;
  attachment: RegisteredTunnelAttachment;
}

interface RegisteredTunnelAttachment extends TunnelAttachment {
  registered: true;
  serverId: string;
  connectionId: string;
  protocolVersion: number;
}

interface HttpRelaySessionRecord {
  handle: string;
  sessionId: string;
  serverId: string;
  userId?: string;
  sessionType: string;
  tunnelConnectionId: string;
  openedAt: string;
  lastSeenAt: string;
  expiresAt: number;
  shardKey: string;
}

interface ServerRouteRecord {
  serverId: string;
  shardKey: string;
  connectionId: string;
  acceptedAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface PendingHttpRequest {
  sessionId: string;
  tunnelConnectionId: string;
  requestMethod: string;
  status: number;
  headers: Headers;
  stream: TransformStream<Uint8Array, Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  started: boolean;
  queuedBytes: number;
  writeChain: Promise<void>;
  maxBufferedBytes: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (response: Response) => void;
  abortSignal: AbortSignal;
  abortListener: () => void;
}

const DEFAULT_CONTROL_URL = 'https://api.omnilux.tv/functions/v1';
const DEFAULT_AUDIENCE = 'relay.omnilux.tv';
const DEFAULT_LEGACY_COORDINATOR_NAME = 'global';
const DEFAULT_RENDEZVOUS_NAME = 'relay-rendezvous-v1';
const DEFAULT_RENDEZVOUS_PARTITIONS = 64;
const DEFAULT_COOKIE_NAME = 'omnilux_relay_session';
const DEFAULT_GRANT_MAX_CLOCK_SKEW_MS = 30_000;
const DEFAULT_GRANT_MAX_TTL_MS = 5 * 60 * 1000;
const DEFAULT_HTTP_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HTTP_REQUEST_BODY_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_HTTP_RESPONSE_BUFFER_MAX_BYTES = 1024 * 1024;
const DEFAULT_RENDEZVOUS_TTL_MS = 2 * 60 * 1000;
const HTTP_SESSION_PREFIX = 'http-session:';
const HTTP_SESSION_BY_ID_PREFIX = 'http-session-by-id:';
const SERVER_ROUTE_PREFIX = 'server-route:';
const WS_OPEN = 1;
const INTERNAL_CONTROL_PATH_PREFIX = '/_relay-internal/';
const INTERNAL_CONTROL_HEADER = 'X-OmniLux-Relay-Internal';
const INTERNAL_CONTROL_VALUE = 'relay-worker-internal-v1';
const INTERNAL_SHARD_HEADER = 'X-OmniLux-Relay-Shard';
const INTERNAL_HTTP_REQUEST_HEADER = 'X-OmniLux-Relay-Request-Id';
const ROUTE_COOKIE_VERSION = 'v1';

class RelayRequestBodyTooLargeError extends Error {}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const purposeFailureDetail: Record<RelaySessionAttachmentPurpose, string> = {
  remote_http: 'Relay grant purpose is not valid for HTTP relay',
  remote_ws: 'Relay grant purpose is not valid for WebSocket relay',
};

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade')?.toLowerCase() ?? '';

    if (upgrade !== 'websocket' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      return jsonResponse({ ok: true, runtime: 'cloudflare-worker' });
    }

    if (upgrade !== 'websocket' && url.pathname === '/readyz') {
      return workerReadinessResponse(env);
    }

    if (url.pathname.startsWith(INTERNAL_CONTROL_PATH_PREFIX)) {
      return jsonResponse({ error: 'Not found' }, { status: 404 });
    }

    const requestBodyLimit = envNumber(
      env.RELAY_HTTP_REQUEST_BODY_MAX_BYTES,
      DEFAULT_HTTP_REQUEST_BODY_MAX_BYTES,
    );
    if (declaredRequestBodyTooLarge(request, requestBodyLimit)) {
      await request.body?.cancel('Relay HTTP request body is too large').catch(() => undefined);
      return jsonResponse({ error: 'Relay HTTP request body is too large' }, { status: 413 });
    }

    const shardKey = await shardKeyForPublicRequest(request, env);
    if (!shardKey) {
      return jsonResponse(
        { error: 'Relay server route is unavailable' },
        { status: 503 },
      );
    }
    let response: Response;
    try {
      response = await fetchCoordinator(env, shardKey, request);
    } catch (error) {
      if (error instanceof RelayRequestBodyTooLargeError) {
        return jsonResponse({ error: error.message }, { status: 413 });
      }
      throw error;
    }
    return exposeCoordinatorResponse(env, shardKey, response, request.signal);
  },
};

export default worker;

export class RelayCoordinator {
  private controlPlaneClient?: RelayControlPlaneClient;
  private readonly pendingHttpRequests = new Map<string, PendingHttpRequest>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade')?.toLowerCase() ?? '';

    if (url.pathname === `${INTERNAL_CONTROL_PATH_PREFIX}readyz`) {
      if (!isInternalControlRequest(request)) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      const activeTunnels = this.state.getWebSockets('role:tunnel')
        .filter((socket) => isRegisteredTunnelAttachment(getSocketAttachment(socket))).length;
      return jsonResponse({ ok: true, activeTunnels });
    }

    if (url.pathname === `${INTERNAL_CONTROL_PATH_PREFIX}supersede` && request.method === 'POST') {
      if (!isInternalControlRequest(request)) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      const body = await request.json().catch(() => null) as JsonRecord | null;
      const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : '';
      if (!connectionId) return jsonResponse({ error: 'connectionId is required' }, { status: 400 });
      const tunnel = this.findTunnelByConnectionId(connectionId);
      if (tunnel) {
        const condition: RelayConditionResult = {
          relayCondition: 'degraded',
          reasonCode: 'control_plane_error',
          detail: 'Superseded by a newer tunnel',
        };
        await this.closeTunnelSessions(connectionId, condition.detail, condition);
        closeSocket(tunnel.socket, 1012, toCloseReason(condition, condition.detail));
      }
      return jsonResponse({ ok: true });
    }

    if (url.pathname === `${INTERNAL_CONTROL_PATH_PREFIX}http-cancel` && request.method === 'POST') {
      if (!isInternalControlRequest(request)) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      const body = await request.json().catch(() => null) as JsonRecord | null;
      const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
      const reason = typeof body?.reason === 'string' && body.reason
        ? body.reason
        : 'Relay HTTP response consumer cancelled';
      if (!requestId) return jsonResponse({ error: 'requestId is required' }, { status: 400 });
      await this.cancelPendingHttpRequest(requestId, reason);
      return jsonResponse({ ok: true });
    }

    if (upgrade === 'websocket') {
      if (url.pathname === '/ws/server') return this.acceptTunnelWebSocket(request);
      if (url.pathname === '/ws/session') return this.acceptSessionWebSocket(request);
      return jsonResponse({ error: 'Unknown relay WebSocket endpoint' }, { status: 404 });
    }

    if (url.pathname === '/health' || url.pathname === '/healthz' || url.pathname === '/readyz') {
      return jsonResponse({ ok: true, runtime: 'cloudflare-durable-object' });
    }

    if (url.pathname.startsWith('/r/')) {
      return this.handleHttpHandoff(request);
    }

    const session = await this.findHttpSessionFromRequest(request);
    if (!session) {
      return jsonResponse({ error: 'Relay HTTP session is required' }, { status: 404 });
    }

    return this.forwardHttpRelayRequest(session, request);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = getSocketAttachment(socket);
    if (!attachment) {
      closeSocket(socket, 1008, 'Missing relay socket attachment');
      return;
    }

    if (attachment.role === 'tunnel') {
      await this.handleTunnelMessage(socket, attachment, message);
      return;
    }

    await this.handleClientSessionMessage(socket, attachment, message);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = getSocketAttachment(socket);
    if (!attachment) return;

    if (attachment.role === 'tunnel' && attachment.registered && attachment.connectionId) {
      if (attachment.serverId) {
        await deleteServerShard(this.env, attachment.serverId, attachment.connectionId);
      }
      const condition = classifyRelayCondition({
        source: 'close',
        code,
        closeReason: reason,
      });
      relayWarn('relay tunnel disconnected', {
        connectionId: attachment.connectionId,
        closeCode: code,
        relayCondition: condition.relayCondition,
        reasonCode: condition.reasonCode,
      });
      await this.closeTunnelSessions(attachment.connectionId, condition.detail, condition);
      return;
    }

    if (attachment.role === 'session' && !attachment.closedByRelay) {
      const condition: RelayConditionResult = {
        relayCondition: 'degraded',
        reasonCode: 'client_socket_error',
        detail: reason || 'Client disconnected',
      };
      this.notifyTunnelSessionClose(attachment, condition.detail, condition);
    }
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    const attachment = getSocketAttachment(socket);
    const condition = classifyRelayCondition({
      source: 'socket-error',
      error: error instanceof Error ? error.message : 'Relay WebSocket error',
    });

    if (attachment?.role === 'tunnel' && attachment.registered && attachment.connectionId) {
      if (attachment.serverId) {
        await deleteServerShard(this.env, attachment.serverId, attachment.connectionId);
      }
      await this.closeTunnelSessions(attachment.connectionId, condition.detail, condition);
    } else if (attachment?.role === 'session' && !attachment.closedByRelay) {
      this.notifyTunnelSessionClose(attachment, condition.detail, condition);
    }
  }

  private acceptTunnelWebSocket(request: Request): Response {
    const token = getBearerToken(request);
    if (!token) {
      return jsonResponse({ error: 'Missing relay tunnel token' }, { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const attachment: TunnelAttachment = {
      role: 'tunnel',
      token,
      registered: false,
      acceptedAt: Date.now(),
      shardKey: request.headers.get(INTERNAL_SHARD_HEADER)
        || this.env.RELAY_LEGACY_COORDINATOR_NAME?.trim()
        || DEFAULT_LEGACY_COORDINATOR_NAME,
    };

    this.state.acceptWebSocket(server, ['role:tunnel']);
    server.serializeAttachment(attachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async acceptSessionWebSocket(request: Request): Promise<Response> {
    const token = getBearerToken(request);
    if (!token) {
      return jsonResponse({ error: 'Missing relay session grant' }, { status: 401 });
    }

    const attachment = await this.attachRelaySession(token, 'remote_ws');
    if (!attachment.ok) {
      return this.relayAttachmentFailureResponse(attachment);
    }

    await this.closeSessionById(
      attachment.consumedSession.sessionId,
      1012,
      'Superseded by an idempotent relay attach retry',
      relayAttachSupersededCondition(),
    );

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const expiresAt = relaySessionExpiresAt(
      attachment.consumedSession,
      envNumber(this.env.RELAY_HTTP_SESSION_TTL_MS, DEFAULT_HTTP_SESSION_TTL_MS),
    );
    const sessionAttachment: ClientSessionAttachment = {
      role: 'session',
      sessionId: attachment.consumedSession.sessionId,
      serverId: attachment.consumedSession.serverId,
      userId: attachment.consumedSession.userId,
      sessionType: attachment.consumedSession.sessionType,
      tunnelConnectionId: attachment.tunnel.attachment.connectionId,
      openedAt: new Date().toISOString(),
      expiresAt,
    };

    this.state.acceptWebSocket(server, ['role:session']);
    server.serializeAttachment(sessionAttachment);

    sendJson(attachment.tunnel.socket, {
      type: 'session-open',
      sessionId: sessionAttachment.sessionId,
      sessionType: sessionAttachment.sessionType,
      metadata: attachment.consumedSession.metadata ?? {},
    });
    sendJson(server, {
      type: 'session-ready',
      sessionId: sessionAttachment.sessionId,
      serverId: sessionAttachment.serverId,
    });

    relayLog('relay websocket session attached', {
      serverId: sessionAttachment.serverId,
      sessionId: sessionAttachment.sessionId,
      connectionId: sessionAttachment.tunnelConnectionId,
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleTunnelMessage(
    socket: WebSocket,
    attachment: TunnelAttachment,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const payload = parseJsonMessage(message);
    if (!payload || typeof payload.type !== 'string') {
      sendJson(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Expected JSON message with type' });
      return;
    }

    if (payload.type === 'register') {
      if (attachment.role === 'tunnel' && attachment.registered) {
        sendJson(socket, { type: 'error', code: 'ALREADY_REGISTERED', message: 'Tunnel is already registered' });
        return;
      }
      await this.registerTunnel(socket, attachment, payload);
      return;
    }

    if (!attachment.registered || !attachment.connectionId) {
      sendJson(socket, { type: 'error', code: 'NOT_REGISTERED', message: 'Tunnel must register before sending frames' });
      return;
    }

    const registeredAttachment = attachment as RegisteredTunnelAttachment;
    switch (payload.type) {
      case 'heartbeat':
        await this.handleTunnelHeartbeat(socket, registeredAttachment, payload);
        break;
      case 'session-frame':
        this.forwardTunnelSessionFrame(payload, registeredAttachment);
        break;
      case 'session-ready':
        break;
      case 'session-close':
        await this.handleTunnelSessionClose(payload, registeredAttachment);
        break;
      case 'http-response-start':
        this.handleHttpResponseStart(payload, registeredAttachment);
        break;
      case 'http-response-body':
        await this.handleHttpResponseBody(payload, registeredAttachment);
        break;
      case 'http-response-end':
        await this.handleHttpResponseEnd(payload, registeredAttachment);
        break;
      case 'http-response-error':
        await this.handleHttpResponseError(payload, registeredAttachment);
        break;
      default:
        sendJson(socket, {
          type: 'error',
          code: 'UNKNOWN_TYPE',
          message: `Unknown tunnel message type: ${payload.type}`,
        });
    }
  }

  private async handleClientSessionMessage(
    socket: WebSocket,
    attachment: ClientSessionAttachment,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (attachment.expiresAt <= Date.now()) {
      const condition: RelayConditionResult = {
        relayCondition: 'expired',
        reasonCode: 'token_expired',
        detail: 'Relay session expired',
      };
      this.closeClientSession(attachment.sessionId, 4401, condition.detail, condition);
      return;
    }

    const tunnel = this.findTunnelByConnectionId(attachment.tunnelConnectionId);
    if (!tunnel) {
      const condition = classifyRelayCondition({
        source: 'session-attach',
        hasActiveTunnel: false,
        error: 'Relay tunnel is not available',
      });
      closeSocket(socket, 1011, toCloseReason(condition, 'Relay tunnel is not available'));
      return;
    }

    const isBinary = message instanceof ArrayBuffer;
    sendJson(tunnel.socket, {
      type: 'session-frame',
      sessionId: attachment.sessionId,
      encoding: isBinary ? 'base64' : 'text',
      data: isBinary ? bytesToBase64(new Uint8Array(message)) : message,
    });
  }

  private async registerTunnel(
    socket: WebSocket,
    attachment: TunnelAttachment,
    payload: JsonRecord,
  ): Promise<void> {
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
      closeSocket(socket, 1008, toCloseReason(condition, condition.detail));
      return;
    }

    const connectionId = crypto.randomUUID();
    const response = await this.controlPlane().registerRelayConnection(attachment.token, {
      connectionId,
      protocolVersion,
      region: typeof payload.region === 'string' ? payload.region : this.env.RELAY_REGION,
      clientVersion: typeof payload.clientVersion === 'string' ? payload.clientVersion : undefined,
      capabilities: isJsonObject(payload.capabilities) ? payload.capabilities : {},
      metadata: isJsonObject(payload.metadata) ? payload.metadata : {},
    });

    const condition = response.ok
      ? ({ relayCondition: 'connected', reasonCode: 'ok', detail: 'register ok' } satisfies RelayConditionResult)
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
      closeSocket(socket, 1011, toCloseReason(condition, 'Relay registration failed'));
      relayWarn('relay tunnel register failed', {
        status: response.status,
        error: response.error,
        relayCondition: condition.relayCondition,
        reasonCode: condition.reasonCode,
      });
      return;
    }

    const registeredAttachment: RegisteredTunnelAttachment = {
      role: 'tunnel',
      token: attachment.token,
      registered: true,
      serverId: response.data.serverId,
      connectionId,
      registeredAt: new Date(attachment.acceptedAt ?? Date.now()).toISOString(),
      protocolVersion,
      region: typeof payload.region === 'string' ? payload.region : this.env.RELAY_REGION,
      clientVersion: typeof payload.clientVersion === 'string' ? payload.clientVersion : undefined,
      capabilities: isJsonObject(payload.capabilities) ? payload.capabilities : undefined,
      shardKey: attachment.shardKey,
    };

    await this.supersedeExistingTunnel(registeredAttachment.serverId, connectionId);
    socket.serializeAttachment(registeredAttachment);
    let routeRegistration: Awaited<ReturnType<typeof registerServerShard>>;
    try {
      routeRegistration = await registerServerShard(
        this.env,
        registeredAttachment.serverId,
        registeredAttachment.shardKey,
        connectionId,
        attachment.acceptedAt ?? Date.now(),
      );
      if (!routeRegistration.published) {
        socket.serializeAttachment(attachment);
        closeSocket(socket, 1012, 'Superseded by a newer tunnel');
        return;
      }
      const previousRoute = routeRegistration.previous;
      if (
        previousRoute
        && previousRoute.connectionId !== connectionId
        && previousRoute.shardKey !== registeredAttachment.shardKey
      ) {
        await this.supersedeRemoteTunnel(previousRoute);
      }
    } catch (error) {
      await deleteServerShard(this.env, registeredAttachment.serverId, connectionId);
      socket.serializeAttachment(attachment);
      const message = error instanceof Error ? error.message : 'Relay rendezvous registration failed';
      sendJson(socket, { type: 'error', code: 'RENDEZVOUS_FAILED', message });
      closeSocket(socket, 1011, message);
      return;
    }

    sendJson(socket, {
      type: 'registered',
      serverId: registeredAttachment.serverId,
      connectionId,
      heartbeatIntervalSeconds: response.data.heartbeatIntervalSeconds,
      relaySessionTtlSeconds: response.data.relaySessionTtlSeconds,
      relayShard: registeredAttachment.shardKey,
      relayRendezvousPartition: routeRegistration.partition,
    });

    relayLog('relay tunnel registered', {
      serverId: registeredAttachment.serverId,
      connectionId,
      protocolVersion,
      relayCondition: condition.relayCondition,
      reasonCode: condition.reasonCode,
    });
  }

  private async handleTunnelHeartbeat(
    socket: WebSocket,
    tunnel: RegisteredTunnelAttachment,
    payload: JsonRecord,
  ): Promise<void> {
    const routeTouch = await touchServerShard(
      this.env,
      tunnel.serverId,
      tunnel.shardKey,
      tunnel.connectionId,
      Date.parse(tunnel.registeredAt ?? ''),
    );
    if (routeTouch === 'superseded') {
      closeSocket(socket, 1012, 'Superseded by a newer tunnel');
      return;
    }
    const outgoingCondition: RelayConditionResult = {
      relayCondition: 'connected',
      reasonCode: 'ok',
      detail: 'heartbeat ok',
    };
    const response = await this.controlPlane().recordRelayHeartbeat(tunnel.token, {
      connectionId: tunnel.connectionId,
      sessionIds: await this.activeSessionIds(tunnel.connectionId),
      relayStatus: relayStatusForControlPlane(outgoingCondition.relayCondition),
      relayCondition: outgoingCondition.relayCondition,
      reasonCode: outgoingCondition.reasonCode,
      protocolVersion: typeof payload.protocolVersion === 'number' ? payload.protocolVersion : tunnel.protocolVersion,
      region: typeof payload.region === 'string' ? payload.region : tunnel.region,
      clientVersion: typeof payload.clientVersion === 'string' ? payload.clientVersion : tunnel.clientVersion,
      capabilities: isJsonObject(payload.capabilities) ? payload.capabilities : tunnel.capabilities ?? {},
      metadata: isJsonObject(payload.metadata) ? payload.metadata : {},
    });

    const condition = response.ok
      ? outgoingCondition
      : classifyRelayCondition({
          source: 'heartbeat',
          status: response.status,
          error: response.error,
        });

    sendJson(socket, {
      type: 'heartbeat-ack',
      connectionId: tunnel.connectionId,
      receivedAt: new Date().toISOString(),
      relayCondition: condition.relayCondition,
      reasonCode: condition.reasonCode,
    });

    if (!response.ok) {
      relayWarn('relay heartbeat failed', {
        serverId: tunnel.serverId,
        connectionId: tunnel.connectionId,
        status: response.status,
        error: response.error,
        relayCondition: condition.relayCondition,
        reasonCode: condition.reasonCode,
      });
    }

    if (response.ok) {
      for (const terminalSession of response.data.terminalSessions ?? []) {
        const sessionId = terminalSession.sessionId;
        const terminalCondition: RelayConditionResult = terminalSession.status === 'expired'
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
        await this.closeSessionById(sessionId, 4401, terminalCondition.detail, terminalCondition);
      }
    }

    if (isTerminalRelayCondition(condition.relayCondition)) {
      await this.closeTunnelSessions(tunnel.connectionId, condition.detail, condition);
      closeSocket(socket, 4401, toCloseReason(condition, 'Relay tunnel authorization ended'));
    }
  }

  private async attachRelaySession(
    token: string,
    purpose: RelaySessionAttachmentPurpose,
  ): Promise<RelaySessionAttachmentResult> {
    const [connectionId, attachAttemptId] = await Promise.all([
      deriveRelaySessionConnectionId(token),
      deriveRelayAttachAttemptId(token),
    ]);
    const grantVerification = await this.verifyRelayGrantToken(token);

    if (!grantVerification.ok) {
      return {
        ok: false,
        connectionId,
        stage: 'grant',
        condition: grantVerification.condition,
      };
    }

    const grant = grantVerification.grant;
    if (grant && grant.purpose !== purpose) {
      return {
        ok: false,
        connectionId,
        stage: 'purpose',
        grant,
        condition: {
          relayCondition: 'unauthorized',
          reasonCode: 'auth_invalid',
          detail: purposeFailureDetail[purpose],
        },
      };
    }

    // A signed one-time grant must never be consumed on the strength of a
    // rendezvous record alone. Routes can expire or briefly outlive a socket
    // close, so confirm that this coordinator owns the exact live route before
    // making the control-plane consume call.
    const expectedTunnel = grant ? this.findTunnelByServerId(grant.serverId) : null;
    if (grant && (
      !expectedTunnel
      || !await tunnelOwnsAuthoritativeRoute(this.env, expectedTunnel)
    )) {
      return {
        ok: false,
        connectionId,
        stage: 'tunnel',
        grant,
        condition: classifyRelayCondition({
          source: 'session-attach',
          hasActiveTunnel: false,
          error: 'No active relay tunnel for this server',
        }),
      };
    }

    const response = await this.controlPlane().consumeRelaySession(token, {
      connectionId,
      attachAttemptId,
    });
    if (!response.ok) {
      const condition = classifyRelayCondition({
        source: 'session-attach',
        status: response.status,
        error: response.error,
      });
      return {
        ok: false,
        connectionId,
        stage: 'consume',
        condition,
        status: response.status,
        error: response.error,
        grant,
      };
    }

    if (
      response.data.connectionId !== connectionId
      || response.data.attachAttemptId !== attachAttemptId
    ) {
      return {
        ok: false,
        connectionId,
        stage: 'binding',
        grant,
        condition: {
          relayCondition: 'unauthorized',
          reasonCode: 'auth_invalid',
          detail: 'Relay consume response does not match the attach attempt',
        },
      };
    }

    if (grant) {
      const bindingCondition = validateRelayGrantSessionBinding(grant, response.data);
      if (bindingCondition) {
        return {
          ok: false,
          connectionId,
          stage: 'binding',
          condition: bindingCondition,
          grant,
        };
      }
    }

    const tunnel = expectedTunnel
      ? this.findTunnelByConnectionId(expectedTunnel.attachment.connectionId)
      : this.findTunnelByServerId(response.data.serverId);
    if (!tunnel) {
      return {
        ok: false,
        connectionId,
        stage: 'tunnel',
        grant,
        condition: classifyRelayCondition({
          source: 'session-attach',
          hasActiveTunnel: false,
          error: 'No active relay tunnel for this server',
        }),
      };
    }
    if (
      tunnel.attachment.serverId !== response.data.serverId
      || (grant && !await tunnelOwnsAuthoritativeRoute(this.env, tunnel))
    ) {
      return {
        ok: false,
        connectionId,
        stage: 'tunnel',
        grant,
        condition: classifyRelayCondition({
          source: 'session-attach',
          hasActiveTunnel: false,
          error: 'Relay tunnel changed while the session was attaching',
        }),
      };
    }

    return {
      ok: true,
      connectionId,
      condition: {
        relayCondition: 'connected',
        reasonCode: 'ok',
        detail: 'consume ok',
      },
      consumedSession: response.data,
      tunnel,
      grant,
    };
  }

  private async handleHttpHandoff(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/r\/([^/]+)(\/.*)?$/);
    const token = match?.[1] ? decodeURIComponent(match[1]) : '';
    const pathAfterToken = match?.[2] || '/';
    if (!token) {
      return jsonResponse({ error: 'Relay session token is required' }, { status: 400 });
    }

    const attachment = await this.attachRelaySession(token, 'remote_http');
    if (!attachment.ok) {
      return this.relayAttachmentFailureResponse(attachment);
    }

    await this.closeSessionById(
      attachment.consumedSession.sessionId,
      1012,
      'Superseded by an idempotent relay attach retry',
      relayAttachSupersededCondition(),
    );

    const now = new Date();
    const ttlMs = envNumber(this.env.RELAY_HTTP_SESSION_TTL_MS, DEFAULT_HTTP_SESSION_TTL_MS);
    const handle = crypto.randomUUID();
    const expiresAt = relaySessionExpiresAt(attachment.consumedSession, ttlMs, now);
    const record: HttpRelaySessionRecord = {
      handle,
      sessionId: attachment.consumedSession.sessionId,
      serverId: attachment.consumedSession.serverId,
      userId: attachment.consumedSession.userId,
      sessionType: attachment.consumedSession.sessionType,
      tunnelConnectionId: attachment.tunnel.attachment.connectionId,
      openedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt,
      shardKey: request.headers.get(INTERNAL_SHARD_HEADER)
        || this.env.RELAY_LEGACY_COORDINATOR_NAME?.trim()
        || DEFAULT_LEGACY_COORDINATOR_NAME,
    };

    await this.putHttpSession(record);
    sendJson(attachment.tunnel.socket, {
      type: 'session-open',
      sessionId: record.sessionId,
      sessionType: record.sessionType,
      metadata: attachment.consumedSession.metadata ?? {},
    });

    relayLog('relay http session opened', {
      serverId: record.serverId,
      sessionId: record.sessionId,
      connectionId: record.tunnelConnectionId,
    });

    const target = `${pathAfterToken}${url.search}`;
    const headers = new Headers({
      Location: target || '/',
      'Set-Cookie': relaySessionCookie({
        cookieName: this.httpSessionCookieName(),
        handle: encodeRelayRouteCookie(record.shardKey, handle),
        maxAgeSeconds: relaySessionMaxAgeSeconds(expiresAt),
        secure: this.secureCookies(),
      }),
    });
    return new Response(null, {
      status: 302,
      headers,
    });
  }

  private async forwardHttpRelayRequest(
    session: HttpRelaySessionRecord,
    request: Request,
  ): Promise<Response> {
    const tunnel = this.findTunnelByConnectionId(session.tunnelConnectionId);
    if (!tunnel) {
      await this.closeHttpRelaySession(session, 'Relay tunnel is unavailable', false);
      return jsonResponse(
        { error: 'Relay tunnel is unavailable' },
        {
          status: 503,
          headers: {
            'Set-Cookie': clearRelaySessionCookie({
              cookieName: this.httpSessionCookieName(),
              secure: this.secureCookies(),
            }),
          },
        },
      );
    }

    const requestId = crypto.randomUUID();
    const pending = this.openPendingHttpRequest(requestId, session, request);

    try {
      const body = await readRequestBody(request, envNumber(
        this.env.RELAY_HTTP_REQUEST_BODY_MAX_BYTES,
        DEFAULT_HTTP_REQUEST_BODY_MAX_BYTES,
      ));
      const url = new URL(request.url);
      sendJson(tunnel.socket, {
        type: 'session-frame',
        sessionId: session.sessionId,
        encoding: 'text',
        data: JSON.stringify({
          type: 'http-request',
          requestId,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: sanitizeRelayIncomingHeaders(request.headers, [this.httpSessionCookieName()]),
          bodyEncoding: body ? 'base64' : undefined,
          body: body ? bytesToBase64(body) : undefined,
        }),
      });
    } catch (error) {
      this.resolvePendingHttpRequest(requestId, jsonResponse({
        error: error instanceof Error ? error.message : 'Relay HTTP request failed',
      }, { status: 413 }));
    }

    return pending;
  }

  private openPendingHttpRequest(
    requestId: string,
    session: HttpRelaySessionRecord,
    request: Request,
  ): Promise<Response> {
    let resolveResponse: (response: Response) => void = () => undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const maxBufferedBytes = Math.max(1, envNumber(
      this.env.RELAY_HTTP_RESPONSE_BUFFER_MAX_BYTES,
      DEFAULT_HTTP_RESPONSE_BUFFER_MAX_BYTES,
    ));
    const strategy = new ByteLengthQueuingStrategy({ highWaterMark: maxBufferedBytes });
    const stream = new TransformStream<Uint8Array, Uint8Array>(undefined, strategy, strategy);
    const writer = stream.writable.getWriter();
    const abortListener = () => {
      void this.cancelPendingHttpRequest(requestId, 'Relay HTTP client disconnected');
    };
    const timeout = setTimeout(() => {
      void this.cancelPendingHttpRequest(
        requestId,
        'Relay HTTP request timed out',
        504,
      );
    }, envNumber(this.env.RELAY_HTTP_REQUEST_TIMEOUT_MS, DEFAULT_HTTP_REQUEST_TIMEOUT_MS));

    const pending: PendingHttpRequest = {
      sessionId: session.sessionId,
      tunnelConnectionId: session.tunnelConnectionId,
      requestMethod: request.method,
      status: 200,
      headers: new Headers({ 'Cache-Control': 'private, no-store' }),
      stream,
      writer,
      started: false,
      queuedBytes: 0,
      writeChain: Promise.resolve(),
      maxBufferedBytes,
      timeout,
      resolve: resolveResponse,
      abortSignal: request.signal,
      abortListener,
    };
    this.pendingHttpRequests.set(requestId, pending);
    request.signal.addEventListener('abort', abortListener, { once: true });
    void writer.closed.catch(() => {
      if (this.pendingHttpRequests.has(requestId)) {
        return this.cancelPendingHttpRequest(requestId, 'Relay HTTP response consumer cancelled');
      }
      return undefined;
    });

    return responsePromise;
  }

  private handleHttpResponseStart(payload: JsonRecord, tunnel: RegisteredTunnelAttachment): void {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const pending = this.getOwnedPendingHttpRequest(payload, tunnel);
    if (!requestId || !pending) return;
    pending.status = validHttpStatus(payload.status) ? payload.status : 502;
    pending.headers = sanitizeRelayOutgoingHeaders(payload.headers, [this.httpSessionCookieName()]);
    pending.headers.set(INTERNAL_HTTP_REQUEST_HEADER, requestId);
    if (!pending.started) {
      pending.started = true;
      if (relayResponseHasNoBody(pending.requestMethod, pending.status)) {
        pending.resolve(new Response(null, {
          status: pending.status,
          headers: pending.headers,
        }));
        void pending.writer.close().catch(() => undefined);
        this.removePendingHttpRequest(requestId);
        return;
      }
      pending.resolve(new Response(pending.stream.readable, {
        status: pending.status,
        headers: pending.headers,
      }));
    }
  }

  private async handleHttpResponseBody(payload: JsonRecord, tunnel: RegisteredTunnelAttachment): Promise<void> {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const pending = this.getOwnedPendingHttpRequest(payload, tunnel);
    if (!requestId || !pending) return;
    if (!pending.started) {
      this.resolvePendingHttpRequest(
        requestId,
        jsonResponse({ error: 'Relay response body arrived before response start' }, { status: 502 }),
        'Relay response body arrived before response start',
      );
      return;
    }
    const data = typeof payload.data === 'string' ? payload.data : '';
    const chunk = payload.encoding === 'base64' ? base64ToBytes(data) : new TextEncoder().encode(data);
    if (chunk.byteLength > pending.maxBufferedBytes || pending.queuedBytes + chunk.byteLength > pending.maxBufferedBytes) {
      await this.cancelPendingHttpRequest(requestId, 'Relay HTTP response exceeded the bounded stream buffer');
      return;
    }

    pending.queuedBytes += chunk.byteLength;
    const write = pending.writeChain.then(() => pending.writer.write(chunk));
    pending.writeChain = write.then(
      () => {
        pending.queuedBytes -= chunk.byteLength;
      },
      () => {
        pending.queuedBytes -= chunk.byteLength;
      },
    );
    void write.catch(() => this.cancelPendingHttpRequest(
      requestId,
      'Relay HTTP response stream failed',
    ));
  }

  private async handleHttpResponseEnd(payload: JsonRecord, tunnel: RegisteredTunnelAttachment): Promise<void> {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const pending = this.getOwnedPendingHttpRequest(payload, tunnel);
    if (!requestId || !pending) return;
    if (!pending.started) this.handleHttpResponseStart(payload, tunnel);
    try {
      await pending.writeChain;
      await pending.writer.close();
    } finally {
      this.removePendingHttpRequest(requestId);
    }
  }

  private async handleHttpResponseError(payload: JsonRecord, tunnel: RegisteredTunnelAttachment): Promise<void> {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const pending = this.getOwnedPendingHttpRequest(payload, tunnel);
    if (!requestId || !pending) return;
    const message = typeof payload.message === 'string' ? payload.message : 'Relay server returned an error';
    this.resolvePendingHttpRequest(requestId, jsonResponse({ error: message }, { status: 502 }), message);
    await pending.writeChain.catch(() => undefined);
  }

  private getOwnedPendingHttpRequest(payload: JsonRecord, tunnel: RegisteredTunnelAttachment): PendingHttpRequest | null {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const pending = requestId ? this.pendingHttpRequests.get(requestId) : undefined;
    if (!pending || pending.sessionId !== sessionId || pending.tunnelConnectionId !== tunnel.connectionId) {
      return null;
    }
    return pending;
  }

  private resolvePendingHttpRequest(requestId: string, response: Response, reason = 'Relay HTTP request failed'): void {
    const pending = this.pendingHttpRequests.get(requestId);
    if (!pending) return;
    this.removePendingHttpRequest(requestId);
    if (pending.started) {
      void pending.writer.abort(new Error(reason)).catch(() => undefined);
    } else {
      pending.resolve(response);
    }
  }

  private removePendingHttpRequest(requestId: string): PendingHttpRequest | null {
    const pending = this.pendingHttpRequests.get(requestId);
    if (!pending) return null;
    this.pendingHttpRequests.delete(requestId);
    clearTimeout(pending.timeout);
    pending.abortSignal.removeEventListener('abort', pending.abortListener);
    return pending;
  }

  private async cancelPendingHttpRequest(
    requestId: string,
    reason: string,
    responseStatus = 502,
  ): Promise<void> {
    const pending = this.removePendingHttpRequest(requestId);
    if (!pending) return;
    const tunnel = this.findTunnelByConnectionId(pending.tunnelConnectionId);
    if (tunnel) {
      sendJson(tunnel.socket, {
        type: 'session-frame',
        sessionId: pending.sessionId,
        encoding: 'text',
        data: JSON.stringify({
          type: 'http-request-cancel',
          requestId,
          reason,
        }),
      });
    }

    if (pending.started) {
      await pending.writer.abort().catch(() => undefined);
    } else {
      pending.resolve(jsonResponse({ error: reason }, { status: responseStatus }));
    }
  }

  private forwardTunnelSessionFrame(payload: JsonRecord, tunnel: RegisteredTunnelAttachment): void {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const session = sessionId ? this.findClientSessionById(sessionId) : null;
    if (!session || session.attachment.tunnelConnectionId !== tunnel.connectionId) return;

    const data = typeof payload.data === 'string' ? payload.data : '';
    if (payload.encoding === 'base64') {
      session.socket.send(base64ToBytes(data));
    } else {
      session.socket.send(data);
    }
  }

  private async handleTunnelSessionClose(
    payload: JsonRecord,
    tunnel: RegisteredTunnelAttachment,
  ): Promise<void> {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) return;
    const condition: RelayConditionResult = {
      relayCondition: 'degraded',
      reasonCode: 'session_attach_error',
      detail: typeof payload.reason === 'string' ? payload.reason : 'Session closed by server',
    };
    const wsSession = this.findClientSessionById(sessionId);
    if (wsSession?.attachment.tunnelConnectionId === tunnel.connectionId) {
      markClientSessionClosedByRelay(wsSession.socket, wsSession.attachment);
      closeSocket(wsSession.socket, 1000, condition.detail);
      return;
    }

    const httpSession = await this.getHttpSessionBySessionId(sessionId);
    if (httpSession?.tunnelConnectionId === tunnel.connectionId) {
      await this.closeHttpRelaySession(httpSession, condition.detail, false);
    }
  }

  private async closeSessionById(
    sessionId: string,
    code: number,
    reason: string,
    condition: RelayConditionResult,
  ): Promise<void> {
    this.closeClientSession(sessionId, code, reason, condition);
    const httpSession = await this.getHttpSessionBySessionId(sessionId);
    if (httpSession) {
      await this.closeHttpRelaySession(httpSession, reason, true, condition);
    }
  }

  private closeClientSession(
    sessionId: string,
    code: number,
    reason: string,
    condition: RelayConditionResult,
  ): void {
    const session = this.findClientSessionById(sessionId);
    if (!session) return;
    this.notifyTunnelSessionClose(session.attachment, reason, condition);
    markClientSessionClosedByRelay(session.socket, session.attachment);
    closeSocket(session.socket, code, toCloseReason(condition, reason));
  }

  private notifyTunnelSessionClose(
    session: ClientSessionAttachment,
    reason: string,
    condition: RelayConditionResult,
  ): void {
    const tunnel = this.findTunnelByConnectionId(session.tunnelConnectionId);
    if (!tunnel) return;
    sendJson(tunnel.socket, {
      type: 'session-close',
      sessionId: session.sessionId,
      reason,
      relayCondition: condition.relayCondition,
      reasonCode: condition.reasonCode,
    });
  }

  private async closeTunnelSessions(
    connectionId: string,
    reason: string,
    condition: RelayConditionResult,
  ): Promise<void> {
    for (const socket of this.state.getWebSockets('role:session')) {
      const attachment = getSocketAttachment(socket);
      if (attachment?.role !== 'session' || attachment.tunnelConnectionId !== connectionId) continue;
      markClientSessionClosedByRelay(socket, attachment);
      closeSocket(socket, 1011, toCloseReason(condition, reason));
    }

    const sessions = await this.state.storage.list<HttpRelaySessionRecord>({ prefix: HTTP_SESSION_PREFIX });
    for (const session of sessions.values()) {
      if (session.tunnelConnectionId === connectionId) {
        await this.closeHttpRelaySession(session, reason, false);
      }
    }

    for (const [requestId, pending] of this.pendingHttpRequests) {
      if (pending.tunnelConnectionId === connectionId) {
        this.resolvePendingHttpRequest(requestId, jsonResponse({ error: reason }, { status: 502 }));
      }
    }
  }

  private async closeHttpRelaySession(
    session: HttpRelaySessionRecord,
    reason: string,
    notifyTunnel: boolean,
    condition: RelayConditionResult = {
      relayCondition: 'degraded',
      reasonCode: 'session_attach_error',
      detail: reason,
    },
  ): Promise<void> {
    await this.deleteHttpSession(session);
    for (const [requestId, pending] of this.pendingHttpRequests) {
      if (pending.sessionId === session.sessionId) {
        this.resolvePendingHttpRequest(requestId, jsonResponse({ error: reason }, { status: 502 }));
      }
    }

    if (!notifyTunnel) return;
    const tunnel = this.findTunnelByConnectionId(session.tunnelConnectionId);
    if (!tunnel) return;
    sendJson(tunnel.socket, {
      type: 'session-close',
      sessionId: session.sessionId,
      reason,
      relayCondition: condition.relayCondition,
      reasonCode: condition.reasonCode,
    });
  }

  private async findHttpSessionFromRequest(request: Request): Promise<HttpRelaySessionRecord | null> {
    const cookie = parseCookies(request.headers.get('Cookie'))[this.httpSessionCookieName()];
    const routedCookie = decodeRelayRouteCookie(cookie);
    const handle = routedCookie?.handle ?? cookie;
    if (!handle) return null;

    const session = await this.state.storage.get<HttpRelaySessionRecord>(`${HTTP_SESSION_PREFIX}${handle}`);
    if (!session) return null;

    const now = new Date();
    if (session.expiresAt <= now.getTime()) {
      await this.closeHttpRelaySession(session, 'Relay HTTP session expired', true, {
        relayCondition: 'expired',
        reasonCode: 'token_expired',
        detail: 'Relay HTTP session expired',
      });
      return null;
    }

    session.lastSeenAt = now.toISOString();
    await this.putHttpSession(session);
    return session;
  }

  private async putHttpSession(session: HttpRelaySessionRecord): Promise<void> {
    await this.state.storage.put(`${HTTP_SESSION_PREFIX}${session.handle}`, session);
    await this.state.storage.put(`${HTTP_SESSION_BY_ID_PREFIX}${session.sessionId}`, session.handle);
  }

  private async deleteHttpSession(session: HttpRelaySessionRecord): Promise<void> {
    const indexedHandle = await this.state.storage.get<string>(`${HTTP_SESSION_BY_ID_PREFIX}${session.sessionId}`);
    await this.state.storage.delete(`${HTTP_SESSION_PREFIX}${session.handle}`);
    if (indexedHandle === session.handle) {
      await this.state.storage.delete(`${HTTP_SESSION_BY_ID_PREFIX}${session.sessionId}`);
    }
  }

  private async getHttpSessionBySessionId(sessionId: string): Promise<HttpRelaySessionRecord | null> {
    const handle = await this.state.storage.get<string>(`${HTTP_SESSION_BY_ID_PREFIX}${sessionId}`);
    if (!handle) return null;
    return await this.state.storage.get<HttpRelaySessionRecord>(`${HTTP_SESSION_PREFIX}${handle}`) ?? null;
  }

  private async activeSessionIds(connectionId: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const socket of this.state.getWebSockets('role:session')) {
      const attachment = getSocketAttachment(socket);
      if (attachment?.role === 'session' && attachment.tunnelConnectionId === connectionId) {
        ids.add(attachment.sessionId);
      }
    }

    const sessions = await this.state.storage.list<HttpRelaySessionRecord>({ prefix: HTTP_SESSION_PREFIX });
    for (const session of sessions.values()) {
      if (session.tunnelConnectionId === connectionId && session.expiresAt > Date.now()) {
        ids.add(session.sessionId);
      }
    }
    return [...ids];
  }

  private async supersedeExistingTunnel(serverId: string, newConnectionId: string): Promise<void> {
    for (const socket of this.state.getWebSockets('role:tunnel')) {
      const attachment = getSocketAttachment(socket);
      if (
        attachment?.role !== 'tunnel'
        || !attachment.registered
        || attachment.serverId !== serverId
        || attachment.connectionId === newConnectionId
      ) {
        continue;
      }

      const condition: RelayConditionResult = {
        relayCondition: 'degraded',
        reasonCode: 'control_plane_error',
        detail: 'Superseded by a newer tunnel',
      };
      if (!isRegisteredTunnelAttachment(attachment)) continue;
      await this.closeTunnelSessions(attachment.connectionId, condition.detail, condition);
      closeSocket(socket, 1012, toCloseReason(condition, 'Superseded by a newer tunnel'));
    }
  }

  private async supersedeRemoteTunnel(previousRoute: ServerRouteRecord): Promise<void> {
    const id = this.env.RELAY_COORDINATOR.idFromName(previousRoute.shardKey);
    await this.env.RELAY_COORDINATOR.get(id).fetch(internalControlRequest('supersede', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: previousRoute.connectionId }),
    }));
  }

  private findTunnelByServerId(serverId: string): DurableTunnel | null {
    for (const socket of this.state.getWebSockets('role:tunnel')) {
      if (socket.readyState !== WS_OPEN) continue;
      const attachment = getSocketAttachment(socket);
      if (isRegisteredTunnelAttachment(attachment) && attachment.serverId === serverId) {
        return { socket, attachment };
      }
    }
    return null;
  }

  private findTunnelByConnectionId(connectionId: string): DurableTunnel | null {
    for (const socket of this.state.getWebSockets('role:tunnel')) {
      if (socket.readyState !== WS_OPEN) continue;
      const attachment = getSocketAttachment(socket);
      if (isRegisteredTunnelAttachment(attachment) && attachment.connectionId === connectionId) {
        return { socket, attachment };
      }
    }
    return null;
  }

  private findClientSessionById(sessionId: string): { socket: WebSocket; attachment: ClientSessionAttachment } | null {
    for (const socket of this.state.getWebSockets('role:session')) {
      if (socket.readyState !== WS_OPEN) continue;
      const attachment = getSocketAttachment(socket);
      if (attachment?.role === 'session' && attachment.sessionId === sessionId) {
        return { socket, attachment };
      }
    }
    return null;
  }

  private verifyRelayGrantToken(token: string): Promise<RelayGrantVerificationResult> {
    return verifyRelayGrantToken(token, {
      requireSignedSessionGrants: this.env.RELAY_ALLOW_LEGACY_SESSION_GRANTS !== 'true',
      publicKeySpkiBase64Url: this.env.RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL?.trim() ?? '',
      audience: this.env.RELAY_GRANT_AUDIENCE?.trim() || DEFAULT_AUDIENCE,
      maxClockSkewMs: envNumber(this.env.RELAY_GRANT_MAX_CLOCK_SKEW_MS, DEFAULT_GRANT_MAX_CLOCK_SKEW_MS),
      maxTtlMs: envNumber(this.env.RELAY_GRANT_MAX_TTL_MS, DEFAULT_GRANT_MAX_TTL_MS),
    });
  }

  private relayAttachmentFailureResponse(attachment: Exclude<RelaySessionAttachmentResult, { ok: true }>): Response {
    relayWarn('relay session attach failed', {
      stage: attachment.stage,
      connectionId: attachment.connectionId,
      relayCondition: attachment.condition.relayCondition,
      reasonCode: attachment.condition.reasonCode,
      detail: attachment.condition.detail,
      ...(attachment.status ? { status: attachment.status } : {}),
      ...(attachment.error ? { error: attachment.error } : {}),
      ...(attachment.grant ? {
        grantId: attachment.grant.grantId,
        grantServerId: attachment.grant.serverId,
        purpose: attachment.grant.purpose,
      } : {}),
    });

    const status = attachment.stage === 'tunnel'
      ? 404
      : attachment.condition.relayCondition === 'unreachable'
        ? 503
        : 401;
    return jsonResponse({
      error: attachment.condition.detail,
      relayCondition: attachment.condition.relayCondition,
      reasonCode: attachment.condition.reasonCode,
    }, { status });
  }

  private controlPlane(): RelayControlPlaneClient {
    if (!this.controlPlaneClient) {
      this.controlPlaneClient = createRelayControlPlaneClient({
        baseUrl: this.env.RELAY_CONTROL_URL?.trim() || DEFAULT_CONTROL_URL,
      });
    }
    return this.controlPlaneClient;
  }

  private httpSessionCookieName(): string {
    return this.env.RELAY_HTTP_SESSION_COOKIE?.trim() || DEFAULT_COOKIE_NAME;
  }

  private secureCookies(): boolean {
    return this.env.RELAY_HTTP_COOKIE_SECURE !== 'false';
  }
}

export class RelayRendezvous {
  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!isInternalControlRequest(request)) {
      return jsonResponse({ error: 'Not found' }, { status: 404 });
    }

    if (url.pathname === `${INTERNAL_CONTROL_PATH_PREFIX}readyz`) {
      return jsonResponse({ ok: true });
    }

    const routeMatch = url.pathname.match(/^\/_relay-internal\/routes\/([a-zA-Z0-9_-]+)$/);
    const routeKey = routeMatch?.[1] ?? '';
    if (!routeKey) return jsonResponse({ error: 'Not found' }, { status: 404 });
    const storageKey = `${SERVER_ROUTE_PREFIX}${routeKey}`;

    if (request.method === 'GET') {
      const route = await this.state.storage.get<ServerRouteRecord>(storageKey);
      if (!route || route.expiresAt <= Date.now()) {
        return jsonResponse({ error: 'Relay server route is unavailable' }, { status: 404 });
      }
      return jsonResponse({ ok: true, route });
    }

    const body = await request.json().catch(() => null) as JsonRecord | null;
    const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : '';
    if (!connectionId) {
      return jsonResponse({ error: 'connectionId is required' }, { status: 400 });
    }

    if (request.method === 'PUT') {
      const serverId = typeof body?.serverId === 'string' ? body.serverId : '';
      const shardKey = typeof body?.shardKey === 'string' && validShardKey(body.shardKey)
        ? body.shardKey
        : '';
      const acceptedAt = typeof body?.acceptedAt === 'number' && Number.isFinite(body.acceptedAt)
        ? body.acceptedAt
        : 0;
      if (!serverId || await sha256Base64Url(serverId) !== routeKey) {
        return jsonResponse({ error: 'Valid serverId is required' }, { status: 400 });
      }
      if (!shardKey || !acceptedAt) {
        return jsonResponse({ error: 'Valid shardKey and acceptedAt are required' }, { status: 400 });
      }
      const previous = await this.state.storage.get<ServerRouteRecord>(storageKey) ?? null;
      if (
        previous
        && previous.connectionId !== connectionId
        && previous.acceptedAt >= acceptedAt
      ) {
        return jsonResponse({ error: 'A newer relay server route already exists' }, { status: 409 });
      }
      const now = Date.now();
      const route: ServerRouteRecord = {
        serverId,
        shardKey,
        connectionId,
        acceptedAt,
        updatedAt: now,
        expiresAt: now + envNumber(this._env.RELAY_RENDEZVOUS_TTL_MS, DEFAULT_RENDEZVOUS_TTL_MS),
      };
      await this.state.storage.put(storageKey, route);
      return jsonResponse({ ok: true, route, previous });
    }

    if (request.method === 'PATCH') {
      const serverId = typeof body?.serverId === 'string' ? body.serverId : '';
      const shardKey = typeof body?.shardKey === 'string' && validShardKey(body.shardKey)
        ? body.shardKey
        : '';
      const acceptedAt = typeof body?.acceptedAt === 'number' && Number.isFinite(body.acceptedAt)
        ? body.acceptedAt
        : 0;
      if (!serverId || await sha256Base64Url(serverId) !== routeKey || !shardKey || !acceptedAt) {
        return jsonResponse({ error: 'Valid server route identity is required' }, { status: 400 });
      }
      const existing = await this.state.storage.get<ServerRouteRecord>(storageKey);
      if (
        existing
        && (
          existing.connectionId !== connectionId
          || existing.shardKey !== shardKey
          || existing.acceptedAt !== acceptedAt
        )
      ) {
        return jsonResponse({ error: 'A different relay server route already exists' }, { status: 409 });
      }
      const now = Date.now();
      const route: ServerRouteRecord = existing ?? {
        serverId,
        shardKey,
        connectionId,
        acceptedAt,
        updatedAt: now,
        expiresAt: now,
      };
      route.updatedAt = now;
      route.expiresAt = now + envNumber(this._env.RELAY_RENDEZVOUS_TTL_MS, DEFAULT_RENDEZVOUS_TTL_MS);
      await this.state.storage.put(storageKey, route);
      return jsonResponse({ ok: true, route });
    }

    if (request.method === 'DELETE') {
      const route = await this.state.storage.get<ServerRouteRecord>(storageKey);
      if (route?.connectionId === connectionId) {
        route.updatedAt = Date.now();
        route.expiresAt = 0;
        await this.state.storage.put(storageKey, route);
      }
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice(7).trim();
}

function getSocketAttachment(socket: WebSocket): SocketAttachment | null {
  try {
    const attachment = socket.deserializeAttachment() as unknown;
    return isSocketAttachment(attachment) ? attachment : null;
  } catch {
    return null;
  }
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.role === 'tunnel') {
    return typeof record.token === 'string' && typeof record.registered === 'boolean';
  }
  if (record.role === 'session') {
    return typeof record.sessionId === 'string'
      && typeof record.serverId === 'string'
      && typeof record.sessionType === 'string'
      && typeof record.tunnelConnectionId === 'string'
      && typeof record.openedAt === 'string'
      && typeof record.expiresAt === 'number';
  }
  return false;
}

function isRegisteredTunnelAttachment(value: SocketAttachment | null): value is RegisteredTunnelAttachment {
  return value?.role === 'tunnel'
    && value.registered === true
    && typeof value.serverId === 'string'
    && typeof value.connectionId === 'string'
    && typeof value.protocolVersion === 'number';
}

function parseJsonMessage(message: string | ArrayBuffer): JsonRecord | null {
  try {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const parsed = JSON.parse(text) as unknown;
    return isJsonObject(parsed) && typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function sendJson(socket: WebSocket, payload: JsonRecord): void {
  if (socket.readyState !== WS_OPEN) return;
  socket.send(JSON.stringify(payload));
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WS_OPEN || socket.readyState === 0) {
    socket.close(code, reason.slice(0, 123));
  }
}

function markClientSessionClosedByRelay(socket: WebSocket, attachment: ClientSessionAttachment): void {
  socket.serializeAttachment({
    ...attachment,
    closedByRelay: true,
  });
}

function jsonResponse(
  body: JsonRecord,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

async function workerReadinessResponse(env: Env): Promise<Response> {
  const signedGrantsRequired = env.RELAY_ALLOW_LEGACY_SESSION_GRANTS !== 'true';
  const configuredKey = env.RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL?.trim() ?? '';
  const keyConfigured = Boolean(configuredKey);
  const keyValid = keyConfigured && await validateRelayGrantPublicKey(configuredKey);
  const relayGrantKeyProbe = keyValid ? 'ok' : keyConfigured ? 'invalid' : 'missing';
  const coordinatorBinding = Boolean(env.RELAY_COORDINATOR);
  const rendezvousBinding = Boolean(env.RELAY_RENDEZVOUS);
  const rendezvousPartitions = rendezvousPartitionCount(env);
  const rendezvousProbePartition = 0;
  let coordinatorProbe = 'failed';
  let rendezvousProbe = 'failed';

  try {
    const coordinatorId = env.RELAY_COORDINATOR.idFromName('ready-probe-v1');
    const response = await env.RELAY_COORDINATOR.get(coordinatorId).fetch(internalControlRequest('readyz'));
    coordinatorProbe = response.ok ? 'ok' : 'failed';
  } catch {
    coordinatorProbe = 'failed';
  }

  try {
    const response = await rendezvousPartitionStub(env, rendezvousProbePartition)
      .fetch(internalControlRequest('readyz'));
    rendezvousProbe = response.ok ? 'ok' : 'failed';
  } catch {
    rendezvousProbe = 'failed';
  }

  const configured = (signedGrantsRequired ? keyValid : !keyConfigured || keyValid)
    && coordinatorBinding
    && rendezvousBinding
    && coordinatorProbe === 'ok'
    && rendezvousProbe === 'ok';
  return jsonResponse({
    ok: configured,
    runtime: 'cloudflare-worker',
    durableObjectBinding: coordinatorBinding,
    rendezvousBinding,
    coordinatorProbe,
    rendezvousProbe,
    rendezvousPartitions,
    rendezvousProbePartition,
    relayGrantKeyProbe,
    signedRelayGrantVerification: signedGrantsRequired ? 'required' : 'legacy-compatible',
  }, { status: configured ? 200 : 503 });
}

async function shardKeyForPublicRequest(request: Request, env: Env): Promise<string | null> {
  const url = new URL(request.url);
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() ?? '';
  const legacy = env.RELAY_LEGACY_COORDINATOR_NAME?.trim() || DEFAULT_LEGACY_COORDINATOR_NAME;

  if (upgrade === 'websocket' && url.pathname === '/ws/server') {
    const token = getBearerToken(request);
    return token ? `t_${await sha256Base64Url(token)}` : legacy;
  }

  let grantToken = '';
  if (upgrade === 'websocket' && url.pathname === '/ws/session') {
    grantToken = getBearerToken(request) ?? '';
  } else if (url.pathname.startsWith('/r/')) {
    const match = url.pathname.match(/^\/r\/([^/]+)/);
    grantToken = match?.[1] ? decodeURIComponent(match[1]) : '';
  }

  if (grantToken) {
    const grant = parseSignedRelayGrantToken(grantToken);
    if (grant) {
      return resolveServerShard(env, grant.serverId);
    }
    return legacy;
  }

  const cookie = parseCookies(request.headers.get('Cookie'))[env.RELAY_HTTP_SESSION_COOKIE?.trim() || DEFAULT_COOKIE_NAME];
  return decodeRelayRouteCookie(cookie)?.shardKey ?? legacy;
}

async function fetchCoordinator(env: Env, shardKey: string, request: Request): Promise<Response> {
  const id = env.RELAY_COORDINATOR.idFromName(shardKey);
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_CONTROL_HEADER);
  headers.set(INTERNAL_SHARD_HEADER, shardKey);
  const init: RequestInit = { headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const body = await readRequestBody(request, envNumber(
      env.RELAY_HTTP_REQUEST_BODY_MAX_BYTES,
      DEFAULT_HTTP_REQUEST_BODY_MAX_BYTES,
    ));
    init.body = body ? arrayBufferFromBytes(body) : null;
  }
  return env.RELAY_COORDINATOR.get(id).fetch(new Request(request, init));
}

function exposeCoordinatorResponse(
  env: Env,
  shardKey: string,
  response: Response,
  requestSignal: AbortSignal,
): Response {
  const requestId = response.headers.get(INTERNAL_HTTP_REQUEST_HEADER);
  if (!requestId) return response;

  const headers = new Headers(response.headers);
  headers.delete(INTERNAL_HTTP_REQUEST_HEADER);
  if (!response.body) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const reader = response.body.getReader();
  let completed = false;
  let cancellation: Promise<void> | null = null;
  const onRequestAbort = () => {
    void cancelUpstream('Relay HTTP client disconnected');
  };
  const finish = () => {
    completed = true;
    requestSignal.removeEventListener('abort', onRequestAbort);
  };
  const cancelUpstream = (reason: unknown): Promise<void> => {
    if (cancellation) return cancellation;
    if (completed) return Promise.resolve();
    finish();
    const cancelReason = relayCancellationReason(reason);
    cancellation = cancelCoordinatorHttpRequest(env, shardKey, requestId, cancelReason)
      .then(() => reader.cancel(reason).catch(() => undefined));
    return cancellation;
  };
  requestSignal.addEventListener('abort', onRequestAbort, { once: true });
  if (requestSignal.aborted) onRequestAbort();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancelUpstream(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cancelCoordinatorHttpRequest(
  env: Env,
  shardKey: string,
  requestId: string,
  reason: string,
): Promise<void> {
  const id = env.RELAY_COORDINATOR.idFromName(shardKey);
  await env.RELAY_COORDINATOR.get(id).fetch(internalControlRequest('http-cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, reason }),
  })).catch(() => undefined);
}

function relayCancellationReason(reason: unknown): string {
  const detail = typeof reason === 'string'
    ? reason.trim()
    : reason instanceof Error
      ? reason.message.trim()
      : '';
  return detail
    ? `Relay HTTP response consumer cancelled: ${detail}`.slice(0, 512)
    : 'Relay HTTP response consumer cancelled';
}

function relayAttachSupersededCondition(): RelayConditionResult {
  return {
    relayCondition: 'degraded',
    reasonCode: 'control_plane_error',
    detail: 'Superseded by an idempotent relay attach retry',
  };
}

export const relayWorkerTestHooks = {
  attachAttemptIdForToken: deriveRelayAttachAttemptId,
  connectionIdForToken: deriveRelaySessionConnectionId,
  exposeCoordinatorResponse,
  rendezvousPartitionForRouteKey,
  workerReadinessResponse,
};

async function resolveServerShard(env: Env, serverId: string): Promise<string | null> {
  return (await resolveServerRoute(env, serverId))?.shardKey ?? null;
}

async function resolveServerRoute(env: Env, serverId: string): Promise<ServerRouteRecord | null> {
  const route = await serverRouteLocator(env, serverId);
  const response = await route.stub.fetch(internalControlRequest(`routes/${route.routeKey}`));
  if (!response.ok) return null;
  const body = await response.json() as { route?: ServerRouteRecord };
  return body.route && validShardKey(body.route.shardKey) ? body.route : null;
}

async function tunnelOwnsAuthoritativeRoute(env: Env, tunnel: DurableTunnel): Promise<boolean> {
  const route = await resolveServerRoute(env, tunnel.attachment.serverId);
  return Boolean(
    route
    && route.shardKey === tunnel.attachment.shardKey
    && route.connectionId === tunnel.attachment.connectionId
    && route.acceptedAt === Date.parse(tunnel.attachment.registeredAt ?? '')
  );
}

async function registerServerShard(
  env: Env,
  serverId: string,
  shardKey: string,
  connectionId: string,
  acceptedAt: number,
): Promise<{ published: boolean; previous: ServerRouteRecord | null; partition: number }> {
  const route = await serverRouteLocator(env, serverId);
  const response = await route.stub.fetch(internalControlRequest(`routes/${route.routeKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, shardKey, connectionId, acceptedAt }),
  }));
  if (response.status === 409) {
    return { published: false, previous: null, partition: route.partition };
  }
  if (!response.ok) throw new Error('Failed to register relay rendezvous route');
  const body = await response.json() as { previous?: ServerRouteRecord | null };
  return {
    published: true,
    previous: body.previous ?? null,
    partition: route.partition,
  };
}

async function touchServerShard(
  env: Env,
  serverId: string,
  shardKey: string,
  connectionId: string,
  acceptedAt: number,
): Promise<'ok' | 'superseded' | 'unavailable'> {
  const route = await serverRouteLocator(env, serverId);
  const response = await route.stub.fetch(internalControlRequest(`routes/${route.routeKey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverId,
      shardKey,
      connectionId,
      acceptedAt: Number.isFinite(acceptedAt) ? acceptedAt : Date.now(),
    }),
  }));
  if (response.ok) return 'ok';
  return response.status === 409 ? 'superseded' : 'unavailable';
}

async function deleteServerShard(env: Env, serverId: string, connectionId: string): Promise<void> {
  const route = await serverRouteLocator(env, serverId);
  await route.stub.fetch(internalControlRequest(`routes/${route.routeKey}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, connectionId }),
  }));
}

async function serverRouteLocator(
  env: Env,
  serverId: string,
): Promise<{ routeKey: string; partition: number; stub: DurableObjectStub }> {
  const routeKey = await sha256Base64Url(serverId);
  const partition = rendezvousPartitionForRouteKey(routeKey, rendezvousPartitionCount(env));
  return { routeKey, partition, stub: rendezvousPartitionStub(env, partition) };
}

function rendezvousPartitionStub(env: Env, partition: number): DurableObjectStub {
  const baseName = env.RELAY_RENDEZVOUS_NAME?.trim() || DEFAULT_RENDEZVOUS_NAME;
  const name = `${baseName}:p${partition.toString().padStart(3, '0')}`;
  return env.RELAY_RENDEZVOUS.get(env.RELAY_RENDEZVOUS.idFromName(name));
}

function rendezvousPartitionCount(env: Env): number {
  const configured = Math.trunc(envNumber(
    env.RELAY_RENDEZVOUS_PARTITIONS,
    DEFAULT_RENDEZVOUS_PARTITIONS,
  ));
  return Math.min(256, Math.max(1, configured));
}

function rendezvousPartitionForRouteKey(routeKey: string, partitionCount: number): number {
  let hash = 2166136261;
  for (let index = 0; index < routeKey.length; index += 1) {
    hash ^= routeKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, Math.trunc(partitionCount));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function validShardKey(value: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
}

function encodeRelayRouteCookie(shardKey: string, handle: string): string {
  const route = bytesToBase64(new TextEncoder().encode(shardKey))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${ROUTE_COOKIE_VERSION}.${route}.${handle}`;
}

function decodeRelayRouteCookie(value: string | undefined): { shardKey: string; handle: string } | null {
  if (!value) return null;
  const match = value.match(/^v1\.([a-zA-Z0-9_-]+)\.([a-fA-F0-9-]{36})$/);
  if (!match) return null;
  try {
    const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const shardKey = new TextDecoder().decode(base64ToBytes(padded));
    return validShardKey(shardKey) ? { shardKey, handle: match[2] } : null;
  } catch {
    return null;
  }
}

function internalControlRequest(action: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(INTERNAL_CONTROL_HEADER, INTERNAL_CONTROL_VALUE);
  return new Request(`https://relay.internal${INTERNAL_CONTROL_PATH_PREFIX}${action}`, {
    ...init,
    headers,
  });
}

function isInternalControlRequest(request: Request): boolean {
  return request.headers.get(INTERNAL_CONTROL_HEADER) === INTERNAL_CONTROL_VALUE;
}

function relayLog(message: string, data?: JsonRecord): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'relay-worker',
    message,
    ...(data ? { data } : {}),
  }));
}

function relayWarn(message: string, data?: JsonRecord): void {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    source: 'relay-worker',
    level: 'warn',
    message,
    ...(data ? { data } : {}),
  }));
}

function relaySessionExpiresAt(session: ConsumedRelaySession, ttlMs: number, now = new Date()): number {
  const cloudExpiresAt = session.expiresAt ? Date.parse(session.expiresAt) : NaN;
  const localExpiresAt = now.getTime() + ttlMs;
  return Number.isFinite(cloudExpiresAt) ? Math.min(localExpiresAt, cloudExpiresAt) : localExpiresAt;
}

function relaySessionCookie(input: {
  cookieName: string;
  handle: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string {
  const secure = input.secure ? '; Secure' : '';
  return `${input.cookieName}=${encodeURIComponent(input.handle)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${input.maxAgeSeconds}${secure}`;
}

function clearRelaySessionCookie(input: {
  cookieName: string;
  secure: boolean;
}): string {
  const secure = input.secure ? '; Secure' : '';
  return `${input.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function relaySessionMaxAgeSeconds(expiresAt: number, now = new Date()): number {
  return Math.max(60, Math.floor((expiresAt - now.getTime()) / 1000));
}

async function readRequestBody(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const limit = Math.max(0, Math.trunc(maxBytes));
  if (declaredRequestBodyTooLarge(request, limit)) {
    await request.body?.cancel('Relay HTTP request body is too large').catch(() => undefined);
    throw new RelayRequestBodyTooLargeError('Relay HTTP request body is too large');
  }
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      if (totalBytes + next.value.byteLength > limit) {
        await reader.cancel('Relay HTTP request body is too large').catch(() => undefined);
        throw new RelayRequestBodyTooLargeError('Relay HTTP request body is too large');
      }
      totalBytes += next.value.byteLength;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return totalBytes > 0 ? concatBytes(chunks) : undefined;
}

function declaredRequestBodyTooLarge(request: Request, maxBytes: number): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  const contentLength = request.headers.get('Content-Length');
  return Boolean(
    contentLength
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > Math.max(0, Math.trunc(maxBytes))
  );
}

function sanitizeRelayIncomingHeaders(headers: Headers, protectedCookieNames: string[] = []): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('sec-websocket-')) return;
    const sanitized = lower === 'cookie' ? sanitizeCookieHeader(value, protectedCookieNames) : value;
    if (sanitized) pairs.push([name, sanitized]);
  });
  return pairs;
}

function sanitizeRelayOutgoingHeaders(headers: unknown, protectedCookieNames: string[] = []): Headers {
  const normalized = new Headers({ 'Cache-Control': 'private, no-store' });
  if (!Array.isArray(headers)) return normalized;

  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [name, value] = pair;
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'set-cookie' && isProtectedSetCookie(value, protectedCookieNames)) continue;
    normalized.append(name, value);
  }

  return normalized;
}

function sanitizeCookieHeader(value: string, protectedCookieNames: string[]): string | null {
  if (protectedCookieNames.length === 0) return value;
  const protectedNames = new Set(protectedCookieNames.map((name) => name.toLowerCase()));
  const segments = value
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => {
      const [name] = segment.split('=', 1);
      return name && !protectedNames.has(name.toLowerCase());
    });
  return segments.length > 0 ? segments.join('; ') : null;
}

function isProtectedSetCookie(value: string, protectedCookieNames: string[]): boolean {
  if (protectedCookieNames.length === 0) return false;
  const [name] = value.split('=', 1);
  return Boolean(name && protectedCookieNames.some((cookieName) => cookieName.toLowerCase() === name.toLowerCase()));
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  for (const segment of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = segment.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join('='));
  }

  return cookies;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function validHttpStatus(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 200
    && value <= 599;
}

function relayResponseHasNoBody(requestMethod: string, status: number): boolean {
  return requestMethod.toUpperCase() === 'HEAD'
    || status === 204
    || status === 205
    || status === 304;
}

function isJsonObject(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function envNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
