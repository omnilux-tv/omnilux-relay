import crypto from 'node:crypto';
import {
  RELAY_GRANT_TOKEN_PREFIX,
  base64UrlToBytes,
  getRelayGrantSigningPayload,
  stableStringify,
  type OmniLuxRelayGrant,
} from '@omnilux/api-contracts';
import type { RelayConditionResult } from './relay-condition.js';

export { RELAY_GRANT_TOKEN_PREFIX, stableStringify };

export type RelayGrant = OmniLuxRelayGrant;

export interface RelayGrantVerificationPolicy {
  requireSignedSessionGrants: boolean;
  publicKeySpkiBase64Url: string;
  audience: string;
  maxClockSkewMs: number;
  maxTtlMs: number;
  now?: () => number;
}

export type RelayGrantVerificationResult =
  | { ok: true; grant?: RelayGrant }
  | { ok: false; condition: RelayConditionResult };

export interface ConsumedRelaySession {
  serverId: string;
  userId?: string;
}

export function parseSignedRelayGrantToken(token: string): RelayGrant | null {
  if (!token.startsWith(RELAY_GRANT_TOKEN_PREFIX)) return null;
  try {
    const decoded = new TextDecoder().decode(base64UrlToBytes(token.slice(RELAY_GRANT_TOKEN_PREFIX.length)));
    const parsed = JSON.parse(decoded) as unknown;
    return isRelayGrant(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function verifyRelayGrantToken(
  token: string,
  policy: RelayGrantVerificationPolicy,
): Promise<RelayGrantVerificationResult> {
  if (!token.startsWith(RELAY_GRANT_TOKEN_PREFIX)) {
    if (!policy.requireSignedSessionGrants) {
      return { ok: true };
    }
    return relayGrantRejected('Signed relay session grant is required');
  }

  const grant = parseSignedRelayGrantToken(token);
  if (!grant) return relayGrantRejected('Invalid relay grant format');

  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  const now = policy.now?.() ?? Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return relayGrantRejected('Invalid relay grant timestamps');
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
  if (expiresAt - issuedAt > policy.maxTtlMs) {
    return relayGrantRejected('Relay grant TTL exceeds maximum');
  }
  if (issuedAt - now > policy.maxClockSkewMs) {
    return relayGrantRejected('Relay grant is not valid yet');
  }
  if (grant.audience !== policy.audience) {
    return relayGrantRejected('Relay grant audience mismatch');
  }
  if (grant.sessionLimit !== 1) {
    return relayGrantRejected('Relay grant session limit must be exactly one');
  }
  if (!grant.scope.includes('relay:session:connect')) {
    return relayGrantRejected('Relay grant scope does not allow session attachment');
  }

  const publicKey = await importRelayGrantPublicKey(policy.publicKeySpkiBase64Url);
  if (!publicKey) return relayGrantRejected('Relay grant verification key is not configured');

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      base64UrlToBytes(grant.signature),
      new TextEncoder().encode(stableStringify(getRelayGrantSigningPayload(grant))),
    );
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) return relayGrantRejected('Relay grant signature is invalid');

  return { ok: true, grant };
}

export function validateRelayGrantSessionBinding(
  grant: RelayGrant,
  session: ConsumedRelaySession,
): RelayConditionResult | null {
  if (session.serverId === grant.serverId && session.userId === grant.subjectAccountId) {
    return null;
  }

  return {
    relayCondition: 'unauthorized',
    reasonCode: 'auth_invalid',
    detail: 'Relay grant does not match consumed session',
  };
}

async function importRelayGrantPublicKey(publicKeySpkiBase64Url: string): Promise<CryptoKey | null> {
  if (!publicKeySpkiBase64Url) return null;
  return crypto.subtle.importKey(
    'spki',
    base64UrlToBytes(publicKeySpkiBase64Url),
    'Ed25519',
    false,
    ['verify'],
  );
}

function relayGrantRejected(detail: string): RelayGrantVerificationResult {
  return {
    ok: false,
    condition: {
      relayCondition: 'unauthorized',
      reasonCode: 'auth_invalid',
      detail,
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRelayGrant(value: unknown): value is RelayGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Record<string, unknown>;
  return grant.contractName === 'relay-grant'
    && grant.contractVersion === 1
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
