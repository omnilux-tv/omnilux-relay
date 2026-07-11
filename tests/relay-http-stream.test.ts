import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  closePendingHttpRelayRequests,
  cancelPendingHttpRelayRequest,
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
  writableLength = 0;
  statusCode = 200;
  jsonBody: unknown;
  chunks: Array<string | Buffer> = [];
  headers = new Map<string, string | string[]>();
  closeListeners: Array<() => void> = [];

  constructor(
    private readonly throwHeader = false,
    private readonly acceptWrites = true,
  ) {}

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
    this.writableLength += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    return this.acceptWrites;
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

test('relay HTTP stream strips relay control cookies before forwarding to the origin', () => {
  assert.deepEqual(
    sanitizeRelayIncomingHeaders(
      {
        cookie: 'theme=dark; omnilux_relay_session=relay-handle; session=origin-session',
        accept: 'text/html',
      },
      ['omnilux_relay_session'],
    ),
    [
      ['cookie', 'theme=dark; session=origin-session'],
      ['accept', 'text/html'],
    ],
  );

  assert.deepEqual(
    sanitizeRelayIncomingHeaders(
      {
        cookie: 'omnilux_relay_session=relay-handle',
      },
      ['omnilux_relay_session'],
    ),
    [],
  );
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

  const cancellations: string[] = [];
  const requestId = openPendingHttpRelayRequest(session, response, {
    timeoutMs: 1,
    createRequestId: () => 'request-1',
    cancelUpstream: (_requestId, reason) => cancellations.push(reason),
  });

  assert.equal(requestId, 'request-1');
  assert.equal(session.pendingRequests.has('request-1'), true);

  await delay(10);

  assert.equal(session.pendingRequests.has('request-1'), false);
  assert.equal(response.statusCode, 504);
  assert.deepEqual(response.jsonBody, { error: 'Relay HTTP request timed out' });
  assert.deepEqual(cancellations, ['Relay HTTP request timed out']);
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
      ['set-cookie', 'omnilux_relay_session=attacker; Path=/'],
      ['set-cookie', 'b=2'],
      ['connection', 'close'],
    ],
    protectedCookieNames: ['omnilux_relay_session'],
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(pending.started, true);
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.deepEqual(response.headers.get('set-cookie'), ['a=1', 'b=2']);

  assert.deepEqual(writeRelayHttpResponseBody(pending, {
    encoding: 'base64',
    data: Buffer.from('hello').toString('base64'),
  }), { ok: true, backpressured: false });
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

test('relay HTTP stream bounds unread response buffers and cancels upstream once', () => {
  const session: HttpRelayStreamSession = { pendingRequests: new Map() };
  const response = new FakeResponse(false, false);
  const cancellations: Array<{ requestId: string; reason: string }> = [];
  const requestId = openPendingHttpRelayRequest(session, response, {
    timeoutMs: 10_000,
    maxBufferedBytes: 8,
    createRequestId: () => 'request-bounded',
    cancelUpstream: (id, reason) => cancellations.push({ requestId: id, reason }),
  });
  const pending = session.pendingRequests.get(requestId);
  assert.ok(pending);

  assert.deepEqual(writeRelayHttpResponseBody(pending, {
    encoding: 'text',
    data: '123456',
  }), { ok: true, backpressured: true });
  const overflow = writeRelayHttpResponseBody(pending, {
    encoding: 'text',
    data: '789',
  });
  assert.deepEqual(overflow, {
    ok: false,
    error: 'Relay HTTP response exceeded the bounded stream buffer',
  });

  if (!overflow.ok) {
    cancelPendingHttpRelayRequest(session, requestId, overflow.error);
    cancelPendingHttpRelayRequest(session, requestId, overflow.error);
  }
  assert.equal(session.pendingRequests.size, 0);
  assert.deepEqual(cancellations, [{
    requestId: 'request-bounded',
    reason: 'Relay HTTP response exceeded the bounded stream buffer',
  }]);
  assert.equal(response.writableEnded, true);
});

test('relay HTTP stream cancels upstream when the downstream client disconnects', () => {
  const session: HttpRelayStreamSession = { pendingRequests: new Map() };
  const response = new FakeResponse();
  const cancellations: string[] = [];
  openPendingHttpRelayRequest(session, response, {
    timeoutMs: 10_000,
    createRequestId: () => 'request-disconnect',
    cancelUpstream: (_id, reason) => cancellations.push(reason),
  });

  response.emitClose();

  assert.equal(session.pendingRequests.size, 0);
  assert.deepEqual(cancellations, ['Relay HTTP client disconnected']);
});
