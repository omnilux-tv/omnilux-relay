import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELAY_GRANT_TOKEN_PREFIX,
  stableStringify,
  validateRelayGrantSessionBinding,
  verifyRelayGrantToken,
  type RelayGrant,
  type RelayGrantVerificationPolicy,
} from '../src/relay-grant-verification.ts';

const keys = generateKeyPairSync('ed25519');
const publicKeySpkiBase64Url = Buffer.from(keys.publicKey.export({
  type: 'spki',
  format: 'der',
})).toString('base64url');

const basePolicy: RelayGrantVerificationPolicy = {
  requireSignedSessionGrants: true,
  publicKeySpkiBase64Url,
  audience: 'relay.omnilux.tv',
  maxClockSkewMs: 30_000,
  maxTtlMs: 5 * 60 * 1000,
  now: () => Date.parse('2026-06-22T00:00:00.000Z'),
};

function createGrant(overrides: Partial<RelayGrant> = {}): RelayGrant {
  const payload: Omit<RelayGrant, 'signature'> = {
    contractName: 'relay-grant',
    contractVersion: 1,
    grantId: `rg_${randomUUID()}`,
    serverId: 'server-123',
    ownerAccountId: 'owner-123',
    subjectAccountId: 'user-123',
    audience: 'relay.omnilux.tv',
    purpose: 'remote_ws',
    scope: ['relay:session:connect'],
    issuedAt: '2026-06-21T23:59:00.000Z',
    expiresAt: '2026-06-22T00:04:00.000Z',
    sessionLimit: 1,
    entitlementLeaseId: 'lease-123',
    issuer: 'api.omnilux.tv',
    keyId: 'test-key',
    signatureAlgorithm: 'ed25519',
    ...withoutSignature(overrides),
  };
  const signature = sign(null, Buffer.from(stableStringify(payload)), keys.privateKey).toString('base64url');
  return { ...payload, signature: overrides.signature ?? signature };
}

function createToken(grant: RelayGrant): string {
  return `${RELAY_GRANT_TOKEN_PREFIX}${Buffer.from(stableStringify(grant)).toString('base64url')}`;
}

function withoutSignature(input: Partial<RelayGrant>): Partial<Omit<RelayGrant, 'signature'>> {
  const { signature: _signature, ...payload } = input;
  return payload;
}

test('relay grant verification accepts valid signed grants', async () => {
  const grant = createGrant();

  await assert.doesNotReject(async () => {
    const result = await verifyRelayGrantToken(createToken(grant), basePolicy);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.grant?.contractName, 'relay-grant');
      assert.equal(result.grant?.contractVersion, 1);
      assert.equal(result.grant?.grantId, grant.grantId);
    }
  });
});

test('relay grant verification preserves unsigned-token compatibility when configured', async () => {
  const result = await verifyRelayGrantToken('legacy-session-token', {
    ...basePolicy,
    requireSignedSessionGrants: false,
  });

  assert.deepEqual(result, { ok: true });
});

test('relay grant verification rejects unsigned tokens when signed grants are required', async () => {
  const result = await verifyRelayGrantToken('legacy-session-token', basePolicy);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.condition.detail, 'Signed relay session grant is required');
  }
});

test('relay grant verification rejects invalid scope and signatures', async () => {
  const badScope = await verifyRelayGrantToken(createToken(createGrant({ scope: ['relay:inspect'] })), basePolicy);
  assert.equal(badScope.ok, false);
  if (!badScope.ok) assert.equal(badScope.condition.detail, 'Relay grant scope does not allow session attachment');

  const badSignature = await verifyRelayGrantToken(createToken(createGrant({ signature: 'bad-signature' })), basePolicy);
  assert.equal(badSignature.ok, false);
  if (!badSignature.ok) assert.equal(badSignature.condition.detail, 'Relay grant signature is invalid');
});

test('relay grant session binding catches mismatched consumed sessions', () => {
  const grant = createGrant();

  assert.equal(validateRelayGrantSessionBinding(grant, {
    serverId: 'server-123',
    userId: 'user-123',
  }), null);

  assert.deepEqual(validateRelayGrantSessionBinding(grant, {
    serverId: 'different-server',
    userId: 'user-123',
  }), {
    relayCondition: 'unauthorized',
    reasonCode: 'auth_invalid',
    detail: 'Relay grant does not match consumed session',
  });
});
