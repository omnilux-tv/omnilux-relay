import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  closePendingHttpRelayRequests,
  endPendingHttpRelayRequest,
  openPendingHttpRelayRequest,
  readRelayHttpRequestBody,
  sanitizeRelayIncomingHeaders,
  startRelayHttpResponse,
  writeRelayHttpResponseBody,
  type HttpRelayStreamSession,
  type RelayHttpResponseLike,
} from '../src/relay-http-stream.js';

class FakeResponse implements RelayHttpResponseLike {
  headersSent = false;
  writableEnded = false;
  statusCode = 200;
  jsonBody: unknown;
  chunks: Array<string | Buffer> = [];
  headers = new Map<string, string | string[]>();
  closeListeners: Array<() => void> = [];

  constructor(private readonly throwHeader = false) {}

  status(code: number): RelayHttpResponseLike {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): unknown {
    this.headersSent = true;
    this.writableEnded = true;
    this.jsonBody = body;
    return this;
  }

  end(): unknown {
    this.writableEnded = true;
    return this;
  }

  write(chunk: string | Buffer): unknown {
    this.headersSent = true;
    this.chunks.push(chunk);
    return true;
  }

  setHeader(name: string, value: string | string[]): unknown {
    if (this.throwHeader && name.toLowerCase() !== 'cache-control') {
      throw new Error('bad header');
    }
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  on(event: 'close', listener: () => void): unknown {
    if (event === 'close') this.closeListeners.push(listener);
    return this;
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener();
  }
}

async function* bodyChunks(chunks: Array<string | Buffer>): AsyncIterable<unknown> {
  for (const chunk of chunks) yield chunk;
}

test('relay HTTP stream filters hop-by-hop and websocket headers', () => {
  assert.deepEqual(sanitizeRelayIncomingHeaders({
    host: 'relay.omnilux.tv',
    connection: 'keep-alive',
    'sec-websocket-key': 'key',
    accept: 'application/json',
    'x-forwarded-for': ['127.0.0.1', '10.0.0.1'],
  }), [
    ['accept', 'application/json'],
    ['x-forwarded-for', '127.0.0.1'],
    ['x-forwarded-for', '10.0.0.1'],
  ]);
});

test('relay HTTP stream reads request bodies within the configured limit', async () => {
  const req = Object.assign(bodyChunks(['abc', Buffer.from('def')]), { method: 'POST' });

  assert.deepEqual(await readRelayHttpRequestBody(req, 6), Buffer.from('abcdef'));
  await assert.rejects(
    () => readRelayHttpRequestBody(Object.assign(bodyChunks(['abcdefg']), { method: 'POST' }), 6),
    /Relay HTTP request body is too large/,
  );
  assert.equal(
    await readRelayHttpRequestBody(Object.assign(bodyChunks(['ignored']), { method: 'GET' }), 1),
    undefined,
  );
});

test('relay HTTP stream times out pending requests and removes them', async () => {
  const session: HttpRelayStreamSession = { pendingRequests: new Map() };
  const response = new FakeResponse();

  const requestId = openPendingHttpRelayRequest(session, response, {
    timeoutMs: 1,
    createRequestId: () => 'request-1',
  });

  assert.equal(requestId, 'request-1');
  assert.equal(session.pendingRequests.has('request-1'), true);

  await delay(10);

  assert.equal(session.pendingRequests.has('request-1'), false);
  assert.equal(response.statusCode, 504);
  assert.deepEqual(response.jsonBody, { error: 'Relay HTTP request timed out' });
});

test('relay HTTP stream starts, writes, and ends a pending response', () => {
  const session: HttpRelayStreamSession = { pendingRequests: new Map() };
  const response = new FakeResponse();
  const requestId = openPendingHttpRelayRequest(session, response, {
    timeoutMs: 10_000,
    createRequestId: () => 'request-1',
  });
  const pending = session.pendingRequests.get(requestId);
  assert.ok(pending);

  const result = startRelayHttpResponse(pending, {
    status: 206,
    headers: [
      ['content-type', 'text/plain'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
      ['connection', 'close'],
    ],
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(pending.started, true);
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.deepEqual(response.headers.get('set-cookie'), ['a=1', 'b=2']);

  writeRelayHttpResponseBody(pending, {
    encoding: 'base64',
    data: Buffer.from('hello').toString('base64'),
  });
  endPendingHttpRelayRequest(session, requestId);

  assert.deepEqual(response.chunks, [Buffer.from('hello')]);
  assert.equal(response.writableEnded, true);
  assert.equal(session.pendingRequests.size, 0);
});

test('relay HTTP stream closes all pending responses on session close', () => {
  const session: HttpRelayStreamSession = { pendingRequests: new Map() };
  const first = new FakeResponse();
  const second = new FakeResponse();

  openPendingHttpRelayRequest(session, first, {
    timeoutMs: 10_000,
    createRequestId: () => 'request-1',
  });
  openPendingHttpRelayRequest(session, second, {
    timeoutMs: 10_000,
    createRequestId: () => 'request-2',
  });

  closePendingHttpRelayRequests(session, 'Relay HTTP session closed');

  assert.equal(session.pendingRequests.size, 0);
  assert.equal(first.statusCode, 502);
  assert.deepEqual(first.jsonBody, { error: 'Relay HTTP session closed' });
  assert.equal(second.statusCode, 502);
  assert.deepEqual(second.jsonBody, { error: 'Relay HTTP session closed' });
});
