import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayControlPlaneClient, postRelayControlPlane } from '../src/relay-control-plane.js';

test('relay control-plane client posts typed register, heartbeat, and consume calls', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({
      ok: true,
      serverId: 'server-1',
      heartbeatIntervalSeconds: 30,
      relaySessionTtlSeconds: 300,
      sessionId: 'session-1',
      sessionType: 'remote-access',
    }), { status: 200 });
  }) as typeof fetch;

  const client = createRelayControlPlaneClient({
    baseUrl: 'https://api.omnilux.tv/functions/v1',
    timeoutMs: 1000,
    fetchImpl,
  });

  await client.registerRelayConnection('relay-token', { connectionId: 'conn-1' });
  await client.recordRelayHeartbeat('relay-token', { connectionId: 'conn-1' });
  await client.consumeRelaySession('grant-token', { connectionId: 'conn-2' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.omnilux.tv/functions/v1/register-relay-connection',
    'https://api.omnilux.tv/functions/v1/relay-heartbeat',
    'https://api.omnilux.tv/functions/v1/consume-relay-session',
  ]);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer relay-token',
  });
  assert.equal(calls[0].init.body, JSON.stringify({ connectionId: 'conn-1' }));
});

test('postRelayControlPlane extracts error messages from non-success JSON responses', async () => {
  const result = await postRelayControlPlane({
    baseUrl: 'https://api.omnilux.tv/functions/v1',
    timeoutMs: 1000,
    path: 'consume-relay-session',
    token: 'bad-token',
    body: { connectionId: 'conn-1' },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: 'Invalid relay session token' }), {
        status: 401,
      })) as typeof fetch,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 401,
    error: 'Invalid relay session token',
  });
});

test('postRelayControlPlane reports network failures as status zero', async () => {
  const result = await postRelayControlPlane({
    baseUrl: 'https://api.omnilux.tv/functions/v1',
    timeoutMs: 1000,
    path: 'relay-heartbeat',
    token: 'relay-token',
    body: {},
    fetchImpl: (async () => {
      throw new Error('connect ETIMEDOUT');
    }) as typeof fetch,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 0,
    error: 'connect ETIMEDOUT',
  });
});
