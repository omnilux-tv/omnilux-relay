import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const relayPort = 18090 + Math.floor(Math.random() * 1000);
const relayOrigin = `http://127.0.0.1:${relayPort}`;

let relayProcess: ChildProcessWithoutNullStreams;

const waitForHealth = async () => {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${relayOrigin}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Relay smoke server did not become healthy in time');
};

before(async () => {
  relayProcess = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RELAY_PORT: String(relayPort),
      RELAY_CONTROL_URL: 'http://127.0.0.1:65535/functions/v1',
      RELAY_HEARTBEAT_INTERVAL_MS: '1000',
    },
    stdio: 'pipe',
  });

  relayProcess.stderr.on('data', () => {});
  relayProcess.stdout.on('data', () => {});

  await waitForHealth();
});

after(async () => {
  if (!relayProcess.killed) {
    relayProcess.kill('SIGTERM');
    await once(relayProcess, 'exit');
  }
});

test('health endpoint reports relay availability', async () => {
  const response = await fetch(`${relayOrigin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('server tunnel websocket rejects unauthenticated clients', async () => {
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/server?nonce=${randomUUID()}`);

  const closeEvent = await new Promise<{ code: number; reason: Buffer }>((resolve, reject) => {
    socket.once('close', (code, reason) => resolve({ code, reason }));
    socket.once('error', reject);
  });

  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Missing relay tunnel token/);
});

test('session websocket rejects unauthenticated clients', async () => {
  const socket = new WebSocket(`${relayOrigin.replace('http', 'ws')}/ws/session?nonce=${randomUUID()}`);

  const closeEvent = await new Promise<{ code: number; reason: Buffer }>((resolve, reject) => {
    socket.once('close', (code, reason) => resolve({ code, reason }));
    socket.once('error', reject);
  });

  assert.equal(closeEvent.code, 4401);
  assert.match(closeEvent.reason.toString('utf8'), /Missing relay session token/);
});
