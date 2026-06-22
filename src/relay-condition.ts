export type JsonRecord = Record<string, unknown>;

export type RelayCondition = 'connected' | 'degraded' | 'unauthorized' | 'expired' | 'revoked' | 'unreachable';
export type RelayReasonCode =
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

export interface RelayConditionResult {
  relayCondition: RelayCondition;
  reasonCode: RelayReasonCode;
  detail: string;
}

export interface RelayConditionEvidence {
  source: 'register' | 'heartbeat' | 'session-attach' | 'close' | 'socket-error';
  status?: number;
  error?: string;
  closeReason?: string;
  hasActiveTunnel?: boolean;
  code?: number;
}

export function isTerminalRelayCondition(condition: RelayCondition): boolean {
  return condition === 'unauthorized' || condition === 'expired' || condition === 'revoked';
}

function normalizeLower(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function hasAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

export function classifyRelayCondition(evidence: RelayConditionEvidence): RelayConditionResult {
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

export function relayStatusForControlPlane(condition: RelayCondition): string {
  return condition === 'connected' ? 'online' : 'degraded';
}

export function toCloseReason(condition: RelayConditionResult, fallback: string): string {
  return `Relay condition ${condition.relayCondition} (${condition.reasonCode}): ${condition.detail}`;
}

export function addConditionMetadata(condition: RelayConditionResult, extra: JsonRecord): JsonRecord {
  return {
    relayCondition: condition.relayCondition,
    reasonCode: condition.reasonCode,
    ...extra,
  };
}
