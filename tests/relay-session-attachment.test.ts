import assert from 'node:assert/strict';
import { test } from 'node:test';
import type WebSocket from 'ws';
import type { RelayControlPlaneClient } from '../src/relay-control-plane.js';
import type { RelayGrant } from '../src/relay-grant-verification.js';
import { attachRelaySession } from '../src/relay-session-attachment.js';
import { createRelayTunnelRegistry, type TunnelConnection } from '../src/relay-tunnel-registry.js';

function fakeSocket(id: string): WebSocket {
  return { id } as unknown as WebSocket;
}

function tunnel(overrides: Partial<TunnelConnection> = {}): TunnelConnection {
  return {
    serverId: 'server-1',
    connectionId: 'tunnel-1',
    token: 'relay-token',
    socket: fakeSocket('socket-1'),
    registeredAt: '2026-06-22T00:00:00.000Z',
    protocolVersion: 1,
    sessions: new Set<string>(),
    ...overrides,
  };
}

function grant(overrides: Partial<RelayGrant> = {}): RelayGrant {
  return {
    contractName: 'relay-grant',
    contractVersion: 1,
    grantId: 'grant-1',
    serverId: 'server-1',
    ownerAccountId: 'owner-1',
    subjectAccountId: 'user-1',
    audience: 'relay.omnilux.tv',
    purpose: 'remote_ws',
    scope: ['relay:session:connect'],
    issuedAt: '2026-06-22T00:00:00.000Z',
    expiresAt: '2026-06-22T00:05:00.000Z',
    sessionLimit: 1,
    entitlementLeaseId: 'lease-1',
    issuer: 'api.omnilux.tv',
    keyId: 'key-1',
    signatureAlgorithm: 'ed25519',
    signature: 'signature',
    ...overrides,
  };
}

function relayControlPlane(
  consumeRelaySession: RelayControlPlaneClient['consumeRelaySession'],
): RelayControlPlaneClient {
  return {
    registerRelayConnection: async () => {
      throw new Error('unexpected register call');
    },
    recordRelayHeartbeat: async () => {
      throw new Error('unexpected heartbeat call');
    },
    consumeRelaySession,
  };
}

test('attachRelaySession consumes a grant and resolves the active tunnel', async () => {
  const registry = createRelayTunnelRegistry();
  const activeTunnel = tunnel();
  registry.register(activeTunnel);
  const consumedBodies: unknown[] = [];

  const result = await attachRelaySession({
    token: 'session-token',
    purpose: 'remote_ws',
    tunnelRegistry: registry,
    createConnectionId: () => 'attach-1',
    verifyGrantToken: async () => ({ ok: true }),
    relayControlPlane: relayControlPlane(async (_token, body) => {
      consumedBodies.push(body);
      return {
        ok: true,
        status: 200,
        data: {
          sessionId: 'session-1',
          serverId: 'server-1',
          userId: 'user-1',
          sessionType: 'remote-access',
          expiresAt: '2026-06-22T00:03:00.000Z',
          metadata: { path: '/library' },
        },
      };
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(consumedBodies, [{ connectionId: 'attach-1' }]);
  assert.equal(result.tunnel, activeTunnel);
  assert.equal(result.consumedSession.sessionId, 'session-1');
  assert.equal(result.condition.relayCondition, 'connected');
});

test('attachRelaySession rejects a signed grant with the wrong relay purpose before consume', async () => {
  let consumed = false;
  const result = await attachRelaySession({
    token: 'signed-token',
    purpose: 'remote_ws',
    tunnelRegistry: createRelayTunnelRegistry(),
    createConnectionId: () => 'attach-1',
    verifyGrantToken: async () => ({ ok: true, grant: grant({ purpose: 'remote_http' }) }),
    relayControlPlane: relayControlPlane(async () => {
      consumed = true;
      throw new Error('unexpected consume call');
    }),
  });

  assert.equal(consumed, false);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'purpose');
  assert.equal(result.condition.detail, 'Relay grant purpose is not valid for WebSocket relay');
});

test('attachRelaySession classifies control-plane consume failures', async () => {
  const result = await attachRelaySession({
    token: 'session-token',
    purpose: 'remote_http',
    tunnelRegistry: createRelayTunnelRegistry(),
    createConnectionId: () => 'attach-1',
    verifyGrantToken: async () => ({ ok: true }),
    relayControlPlane: relayControlPlane(async () => ({
      ok: false,
      status: 401,
      error: 'invalid token',
    })),
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'consume');
  assert.equal(result.condition.relayCondition, 'unauthorized');
  assert.equal(result.condition.reasonCode, 'auth_invalid');
});

test('attachRelaySession rejects consumed sessions that do not match the signed grant', async () => {
  const registry = createRelayTunnelRegistry();
  registry.register(tunnel({ serverId: 'server-2' }));

  const result = await attachRelaySession({
    token: 'signed-token',
    purpose: 'remote_ws',
    tunnelRegistry: registry,
    createConnectionId: () => 'attach-1',
    verifyGrantToken: async () => ({ ok: true, grant: grant({ serverId: 'server-1' }) }),
    relayControlPlane: relayControlPlane(async () => ({
      ok: true,
      status: 200,
      data: {
        sessionId: 'session-1',
        serverId: 'server-2',
        userId: 'user-1',
        sessionType: 'remote-access',
      },
    })),
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'binding');
  assert.equal(result.condition.detail, 'Relay grant does not match consumed session');
});

test('attachRelaySession reports missing active tunnels after successful consumption', async () => {
  const result = await attachRelaySession({
    token: 'session-token',
    purpose: 'remote_ws',
    tunnelRegistry: createRelayTunnelRegistry(),
    createConnectionId: () => 'attach-1',
    verifyGrantToken: async () => ({ ok: true }),
    relayControlPlane: relayControlPlane(async () => ({
      ok: true,
      status: 200,
      data: {
        sessionId: 'session-1',
        serverId: 'server-missing',
        userId: 'user-1',
        sessionType: 'remote-access',
      },
    })),
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'tunnel');
  assert.equal(result.condition.relayCondition, 'unreachable');
  assert.equal(result.condition.reasonCode, 'tunnel_missing');
});
