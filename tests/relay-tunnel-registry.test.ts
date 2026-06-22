import assert from 'node:assert/strict';
import { test } from 'node:test';
import type WebSocket from 'ws';
import { createRelayTunnelRegistry, type TunnelConnection } from '../src/relay-tunnel-registry.js';

function fakeSocket(id: string): WebSocket {
  return { id } as unknown as WebSocket;
}

function tunnel(overrides: Partial<TunnelConnection> = {}): TunnelConnection {
  return {
    serverId: 'server-1',
    connectionId: 'connection-1',
    token: 'relay-token',
    socket: fakeSocket('socket-1'),
    registeredAt: '2026-06-22T00:00:00.000Z',
    protocolVersion: 1,
    sessions: new Set<string>(),
    ...overrides,
  };
}

test('relay tunnel registry indexes registered tunnels by server, connection, and socket', () => {
  const registry = createRelayTunnelRegistry();
  const registered = tunnel();

  assert.equal(registry.register(registered), undefined);

  assert.equal(registry.getByServerId('server-1'), registered);
  assert.equal(registry.getByConnectionId('connection-1'), registered);
  assert.equal(registry.findBySocket(registered.socket), registered);
});

test('relay tunnel registry preserves newer server lookup when removing a stale connection', () => {
  const registry = createRelayTunnelRegistry();
  const previous = tunnel({ connectionId: 'connection-old', socket: fakeSocket('socket-old') });
  const next = tunnel({ connectionId: 'connection-new', socket: fakeSocket('socket-new') });

  registry.register(previous);
  assert.equal(registry.register(next), previous);

  assert.equal(registry.removeByConnectionId('connection-old'), previous);
  assert.equal(registry.getByConnectionId('connection-old'), undefined);
  assert.equal(registry.getByServerId('server-1'), next);

  assert.equal(registry.removeByConnectionId('connection-new'), next);
  assert.equal(registry.getByConnectionId('connection-new'), undefined);
  assert.equal(registry.getByServerId('server-1'), undefined);
});

test('relay tunnel registry owns session attachment mutation for active tunnels', () => {
  const registry = createRelayTunnelRegistry();
  const registered = tunnel();

  registry.register(registered);
  registry.addSession('connection-1', 'session-1');
  registry.addSession('missing-connection', 'session-2');

  assert.deepEqual(Array.from(registered.sessions), ['session-1']);

  registry.removeSession(undefined, 'session-1');
  assert.deepEqual(Array.from(registered.sessions), ['session-1']);

  registry.removeSession('connection-1', 'session-1');
  assert.deepEqual(Array.from(registered.sessions), []);
});
