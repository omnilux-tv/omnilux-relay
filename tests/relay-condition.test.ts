import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addConditionMetadata,
  classifyRelayCondition,
  isTerminalRelayCondition,
  relayStatusForControlPlane,
  toCloseReason,
} from '../src/relay-condition.ts';

test('classifyRelayCondition maps auth, expiry, revocation, and tunnel evidence', () => {
  assert.deepEqual(classifyRelayCondition({ source: 'register', status: 401 }), {
    relayCondition: 'unauthorized',
    reasonCode: 'auth_invalid',
    detail: 'authentication/authorization rejected',
  });

  assert.deepEqual(classifyRelayCondition({ source: 'heartbeat', error: 'token revoked by control plane' }), {
    relayCondition: 'revoked',
    reasonCode: 'token_revoked',
    detail: 'token revoked by control plane',
  });

  assert.deepEqual(classifyRelayCondition({ source: 'session-attach', status: 410 }), {
    relayCondition: 'expired',
    reasonCode: 'token_expired',
    detail: 'token/session expired',
  });

  assert.deepEqual(classifyRelayCondition({ source: 'session-attach', hasActiveTunnel: false }), {
    relayCondition: 'unreachable',
    reasonCode: 'tunnel_missing',
    detail: 'No active relay tunnel for this server',
  });
});

test('classifyRelayCondition maps transport and control-plane failures', () => {
  assert.deepEqual(classifyRelayCondition({ source: 'socket-error', error: 'socket hang up' }), {
    relayCondition: 'degraded',
    reasonCode: 'socket_error',
    detail: 'socket hang up',
  });

  assert.deepEqual(classifyRelayCondition({ source: 'heartbeat', status: 503 }), {
    relayCondition: 'unreachable',
    reasonCode: 'control_plane_unreachable',
    detail: 'control plane unreachable',
  });

  assert.deepEqual(classifyRelayCondition({ source: 'heartbeat', status: 429, error: 'rate limited' }), {
    relayCondition: 'degraded',
    reasonCode: 'control_plane_error',
    detail: 'rate limited',
  });
});

test('condition formatting helpers preserve relay runtime metadata shape', () => {
  const condition = classifyRelayCondition({ source: 'heartbeat' });

  assert.equal(relayStatusForControlPlane(condition.relayCondition), 'online');
  assert.equal(isTerminalRelayCondition('expired'), true);
  assert.equal(isTerminalRelayCondition('unreachable'), false);
  assert.equal(toCloseReason(condition, 'unused'), 'Relay condition connected (ok): ok');
  assert.deepEqual(addConditionMetadata(condition, { serverId: 'server-123' }), {
    relayCondition: 'connected',
    reasonCode: 'ok',
    serverId: 'server-123',
  });
});
