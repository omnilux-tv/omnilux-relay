import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRelaySessionCookie,
  closeExpiredHttpRelaySessions,
  createHttpRelaySessionRecord,
  createRelayHttpSessionStore,
  findHttpRelaySessionFromCookie,
  relayHandoffRedirectTarget,
  relaySessionCookie,
  relaySessionMaxAgeSeconds,
} from '../src/relay-http-session.js';

test('creates browser HTTP relay session records with local and cloud expiry policy', () => {
  const now = new Date('2026-06-24T10:00:00.000Z');
  const session = createHttpRelaySessionRecord({
    handle: 'handle-1',
    consumedSession: {
      sessionId: 'session-1',
      serverId: 'server-1',
      userId: 'user-1',
      sessionType: 'remote-access',
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    },
    tunnelConnectionId: 'conn-1',
    ttlMs: 60_000,
    now,
  });

  assert.equal(session.handle, 'handle-1');
  assert.equal(session.sessionId, 'session-1');
  assert.equal(session.tunnelConnectionId, 'conn-1');
  assert.equal(session.openedAt, now.toISOString());
  assert.equal(session.lastSeenAt, now.toISOString());
  assert.equal(session.expiresAt, now.getTime() + 30_000);
});

test('renders relay handoff cookies and redirect targets from one Interface', () => {
  assert.equal(
    relaySessionCookie({
      cookieName: 'omnilux_relay_session',
      handle: 'handle with spaces',
      maxAgeSeconds: 120,
      secure: true,
    }),
    'omnilux_relay_session=handle%20with%20spaces; HttpOnly; SameSite=Lax; Path=/; Max-Age=120; Secure',
  );
  assert.equal(
    clearRelaySessionCookie({ cookieName: 'omnilux_relay_session', secure: false }),
    'omnilux_relay_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  );
  assert.equal(
    relaySessionMaxAgeSeconds(new Date('2026-06-24T10:02:30.000Z').getTime(), new Date('2026-06-24T10:00:00.000Z')),
    150,
  );
  assert.equal(relayHandoffRedirectTarget('/r/token/library?view=recent', '/library'), '/library?view=recent');
});

test('looks up browser HTTP relay sessions from cookies and updates last-seen time', () => {
  const store = createRelayHttpSessionStore();
  const now = new Date('2026-06-24T10:00:00.000Z');
  const session = createHttpRelaySessionRecord({
    handle: 'handle-1',
    consumedSession: {
      sessionId: 'session-1',
      serverId: 'server-1',
      sessionType: 'remote-access',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
    tunnelConnectionId: 'conn-1',
    ttlMs: 60_000,
    now,
  });
  store.add(session);

  const seenAt = new Date('2026-06-24T10:00:05.000Z');
  const found = findHttpRelaySessionFromCookie({
    cookieHeader: 'other=value; omnilux_relay_session=handle-1',
    cookieName: 'omnilux_relay_session',
    store,
    onExpired: () => assert.fail('session should not expire'),
    now: seenAt,
  });

  assert.equal(found, session);
  assert.equal(session.lastSeenAt, seenAt.toISOString());
  assert.equal(store.getBySessionId('session-1'), session);
});

test('expires browser HTTP relay sessions through lookup and sweep paths', () => {
  const store = createRelayHttpSessionStore();
  const now = new Date('2026-06-24T10:00:00.000Z');
  const expired = createHttpRelaySessionRecord({
    handle: 'expired-handle',
    consumedSession: {
      sessionId: 'expired-session',
      serverId: 'server-1',
      sessionType: 'remote-access',
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
    },
    tunnelConnectionId: 'conn-1',
    ttlMs: 60_000,
    now,
  });
  const sweepExpired = createHttpRelaySessionRecord({
    handle: 'sweep-handle',
    consumedSession: {
      sessionId: 'sweep-session',
      serverId: 'server-1',
      sessionType: 'remote-access',
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
    },
    tunnelConnectionId: 'conn-1',
    ttlMs: 60_000,
    now,
  });
  store.add(expired);
  store.add(sweepExpired);

  const closed: string[] = [];
  const found = findHttpRelaySessionFromCookie({
    cookieHeader: 'omnilux_relay_session=expired-handle',
    cookieName: 'omnilux_relay_session',
    store,
    onExpired: (session) => {
      closed.push(session.sessionId);
      store.remove(session);
    },
    now,
  });

  assert.equal(found, null);
  closeExpiredHttpRelaySessions(
    store,
    (session, reason) => {
      closed.push(`${session.sessionId}:${reason}`);
      store.remove(session);
    },
    now,
  );

  assert.deepEqual(closed, [
    'expired-session',
    'sweep-session:Relay HTTP session expired',
  ]);
  assert.equal(store.getByHandle('expired-handle'), undefined);
  assert.equal(store.getByHandle('sweep-handle'), undefined);
});
