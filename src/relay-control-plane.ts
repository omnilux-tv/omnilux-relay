import type { JsonRecord } from './relay-condition.js';

export type RelayControlPlaneResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

export type RelayConnectionRegistration = {
  ok: boolean;
  serverId: string;
  heartbeatIntervalSeconds: number;
  relaySessionTtlSeconds: number;
};

export type RelayHeartbeatResult = {
  ok: boolean;
  terminalSessions?: Array<{
    sessionId: string;
    status: string;
  }>;
};

export type ConsumedRelaySession = {
  sessionId: string;
  serverId: string;
  userId?: string;
  sessionType: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
};

export type RelayControlPlaneClient = {
  registerRelayConnection: (
    token: string,
    body: JsonRecord,
  ) => Promise<RelayControlPlaneResult<RelayConnectionRegistration>>;
  recordRelayHeartbeat: (
    token: string,
    body: JsonRecord,
  ) => Promise<RelayControlPlaneResult<RelayHeartbeatResult>>;
  consumeRelaySession: (
    token: string,
    body: JsonRecord,
  ) => Promise<RelayControlPlaneResult<ConsumedRelaySession>>;
};

export type RelayControlPlaneClientOptions = {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createRelayControlPlaneClient(
  options: RelayControlPlaneClientOptions,
): RelayControlPlaneClient {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const post = <T>(path: string, token: string, body: JsonRecord) =>
    postRelayControlPlane<T>({
      baseUrl: options.baseUrl,
      timeoutMs,
      fetchImpl: options.fetchImpl ?? fetch,
      path,
      token,
      body,
    });

  return {
    registerRelayConnection: (token, body) =>
      post<RelayConnectionRegistration>('register-relay-connection', token, body),
    recordRelayHeartbeat: (token, body) =>
      post<RelayHeartbeatResult>('relay-heartbeat', token, body),
    consumeRelaySession: (token, body) =>
      post<ConsumedRelaySession>('consume-relay-session', token, body),
  };
}

export async function postRelayControlPlane<T>(input: {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  path: string;
  token: string;
  body: JsonRecord;
}): Promise<RelayControlPlaneResult<T>> {
  try {
    const response = await input.fetchImpl(`${input.baseUrl}/${input.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) as T : undefined;

    return response.ok && data !== undefined
      ? { ok: true, status: response.status, data }
      : {
          ok: false,
          status: response.status,
          error: (data as { error?: string } | undefined)?.error ?? text,
        };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : 'Unknown relay control-plane error',
    };
  }
}
