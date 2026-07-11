import assert from 'node:assert/strict';
import { test } from 'node:test';
import type WebSocket from 'ws';
import type { RelayControlPlaneClient } from '../src/relay-control-plane.js';
import {
  deriveRelayAttachAttemptId,
  deriveRelaySessionConnectionId,
} from '../src/relay-attach-attempt.js';
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
    verifyGrantToken: async () => ({ ok: true }),
    relayControlPlane: relayControlPlane(async (_token, body) => {
      consumedBodies.push(body);
      return {
        ok: true,
        status: 200,
        data: {
          sessionId: 'session-1',
          serverId: 'server-1',
          connectionId: body.connectionId,
          attachAttemptId: body.attachAttemptId,
          userId: 'user-1',
          sessionType: 'remote-access',
          expiresAt: '2026-06-22T00:03:00.000Z',
          metadata: { path: '/library' },
        },
      };
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(consumedBodies, [{
    connectionId: await deriveRelaySessionConnectionId('session-token'),
    attachAttemptId: await deriveRelayAttachAttemptId('session-token'),
  }]);
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
  registry.register(tunnel({ serverId: 'server-1' }));

  const result = await attachRelaySession({
    token: 'signed-token',
    purpose: 'remote_ws',
    tunnelRegistry: registry,
    verifyGrantToken: async () => ({ ok: true, grant: grant({ serverId: 'server-1' }) }),
    relayControlPlane: relayControlPlane(async (_token, body) => ({
      ok: true,
      status: 200,
      data: {
        sessionId: 'session-1',
        serverId: 'server-2',
        connectionId: body.connectionId,
        attachAttemptId: body.attachAttemptId,
        userId: 'user-1',
        sessionType: 'remote-access',
      },
    })),
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'binding');
  assert.equal(result.condition.detail, 'Relay grant does not match consumed session');
});

test('attachRelaySession rejects a consume response bound to different replay identifiers', async () => {
  const result = await attachRelaySession({
    token: 'session-token',
    purpose: 'remote_ws',
    tunnelRegistry: createRelayTunnelRegistry(),
    verifyGrantToken: async () => ({ ok: true }),
    relayControlPlane: relayControlPlane(async (_token, body) => ({
      ok: true,
      status: 200,
      data: {
        sessionId: 'session-1',
        serverId: 'server-1',
        connectionId: `${body.connectionId}-stale`,
        attachAttemptId: body.attachAttemptId,
        sessionType: 'remote-access',
      },
    })),
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'binding');
  assert.match(result.condition.detail, /does not match the attach attempt/i);
});

test('attachRelaySession does not consume a signed grant without its live tunnel', async () => {
  let consumed = false;
  const result = await attachRelaySession({
    token: 'signed-token',
    purpose: 'remote_ws',
    tunnelRegistry: createRelayTunnelRegistry(),
    verifyGrantToken: async () => ({ ok: true, grant: grant() }),
    relayControlPlane: relayControlPlane(async () => {
      consumed = true;
      throw new Error('unexpected consume call');
    }),
  });

  assert.equal(consumed, false);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'tunnel');
  assert.equal(result.condition.reasonCode, 'tunnel_missing');
});

test('attachRelaySession reuses a stable attempt ID after a lost consume response', async () => {
  const registry = createRelayTunnelRegistry();
  const activeTunnel = tunnel();
  registry.register(activeTunnel);
  const consumeBodies: Array<{ connectionId: string; attachAttemptId: string }> = [];
  const controlPlane = relayControlPlane(async (_token, body) => {
    consumeBodies.push(body);
    if (consumeBodies.length === 1) {
      return { ok: false, status: 0, error: 'response lost after commit' };
    }
    return {
      ok: true,
      status: 200,
      data: {
        sessionId: 'session-replayed',
        serverId: 'server-1',
        connectionId: body.connectionId,
        attachAttemptId: body.attachAttemptId,
        userId: 'user-1',
        sessionType: 'remote-access',
      },
    };
  });
  const input = {
    token: 'signed-replay-token',
    purpose: 'remote_ws' as const,
    tunnelRegistry: registry,
    verifyGrantToken: async () => ({ ok: true as const, grant: grant() }),
    relayControlPlane: controlPlane,
  };

  const first = await attachRelaySession(input);
  const second = await attachRelaySession(input);

  assert.equal(first.ok, false);
  assert.equal(first.stage, 'consume');
  assert.equal(second.ok, true);
  assert.equal(consumeBodies[0].connectionId, consumeBodies[1].connectionId);
  assert.equal(
    consumeBodies[0].connectionId,
    await deriveRelaySessionConnectionId('signed-replay-token'),
  );
  assert.equal(consumeBodies[0].attachAttemptId, consumeBodies[1].attachAttemptId);
  assert.equal(
    consumeBodies[0].attachAttemptId,
    await deriveRelayAttachAttemptId('signed-replay-token'),
  );
});

test('attachRelaySession fences a tunnel change during consume and safely replays on retry', async () => {
  const registry = createRelayTunnelRegistry();
  const firstTunnel = tunnel({ connectionId: 'tunnel-old' });
  const nextTunnel = tunnel({ connectionId: 'tunnel-new', socket: fakeSocket('socket-new') });
  registry.register(firstTunnel);
  const consumeBodies: Array<{ connectionId: string; attachAttemptId: string }> = [];
  const controlPlane = relayControlPlane(async (_token, body) => {
    consumeBodies.push(body);
    if (consumeBodies.length === 1) registry.register(nextTunnel);
    return {
      ok: true,
      status: 200,
      data: {
        sessionId: 'session-replayed',
        serverId: 'server-1',
        connectionId: body.connectionId,
        attachAttemptId: body.attachAttemptId,
        userId: 'user-1',
        sessionType: 'remote-access',
      },
    };
  });
  const input = {
    token: 'signed-disconnect-token',
    purpose: 'remote_ws' as const,
    tunnelRegistry: registry,
    verifyGrantToken: async () => ({ ok: true as const, grant: grant() }),
    relayControlPlane: controlPlane,
  };

  const first = await attachRelaySession(input);
  const second = await attachRelaySession(input);

  assert.equal(first.ok, false);
  assert.equal(first.stage, 'tunnel');
  assert.match(first.condition.detail, /changed while the session was attaching/i);
  assert.equal(second.ok, true);
  assert.equal(second.tunnel, nextTunnel);
  assert.equal(consumeBodies[0].connectionId, consumeBodies[1].connectionId);
  assert.equal(consumeBodies[0].attachAttemptId, consumeBodies[1].attachAttemptId);
});

test('attachRelaySession reports missing active tunnels after successful consumption', async () => {
  const result = await attachRelaySession({
    token: 'session-token',
    purpose: 'remote_ws',
    tunnelRegistry: createRelayTunnelRegistry(),
    verifyGrantToken: async () => ({ ok: true }),
    relayControlPlane: relayControlPlane(async (_token, body) => ({
      ok: true,
      status: 200,
      data: {
        sessionId: 'session-1',
        serverId: 'server-missing',
        connectionId: body.connectionId,
        attachAttemptId: body.attachAttemptId,
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
