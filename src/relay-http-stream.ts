import type { JsonRecord } from './relay-condition.js';

export type RelayHttpResponseLike = {
  headersSent: boolean;
  writableEnded: boolean;
  status: (code: number) => RelayHttpResponseLike;
  json: (body: unknown) => unknown;
  end: () => unknown;
  write: (chunk: string | Buffer) => unknown;
  setHeader: (name: string, value: string | string[]) => unknown;
  on?: (event: 'close', listener: () => void) => unknown;
};

export interface PendingHttpRelayRequest {
  response: RelayHttpResponseLike;
  timeout: NodeJS.Timeout;
  started: boolean;
}

export interface HttpRelayStreamSession {
  pendingRequests: Map<string, PendingHttpRelayRequest>;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export function sanitizeRelayIncomingHeaders(
  headers: Record<string, string | string[] | undefined>,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('sec-websocket-')) continue;
    if (Array.isArray(value)) {
      for (const item of value) pairs.push([name, item]);
    } else if (typeof value === 'string') {
      pairs.push([name, value]);
    }
  }
  return pairs;
}

export function sanitizeRelayOutgoingHeaders(headers: unknown): Map<string, string[]> {
  const normalized = new Map<string, string[]>();
  if (!Array.isArray(headers)) return normalized;

  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [name, value] = pair;
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    const existing = normalized.get(lower) ?? [];
    existing.push(value);
    normalized.set(lower, existing);
  }

  return normalized;
}

export async function readRelayHttpRequestBody(
  req: AsyncIterable<unknown> & { method: string },
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = relayHttpChunkToBuffer(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error('Relay HTTP request body is too large');
    }
    chunks.push(buffer);
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function relayHttpChunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(String(chunk));
}

export function openPendingHttpRelayRequest(
  session: HttpRelayStreamSession,
  response: RelayHttpResponseLike,
  options: {
    timeoutMs: number;
    createRequestId: () => string;
  },
): string {
  const requestId = options.createRequestId();
  const timeout = setTimeout(() => {
    timeoutPendingHttpRelayRequest(session, requestId);
  }, options.timeoutMs);

  session.pendingRequests.set(requestId, {
    response,
    timeout,
    started: false,
  });

  response.on?.('close', () => {
    if (response.writableEnded) return;
    removePendingHttpRelayRequest(session, requestId);
  });

  return requestId;
}

export function removePendingHttpRelayRequest(
  session: HttpRelayStreamSession,
  requestId: string,
): PendingHttpRelayRequest | undefined {
  const pending = session.pendingRequests.get(requestId);
  if (!pending) return undefined;
  session.pendingRequests.delete(requestId);
  clearTimeout(pending.timeout);
  return pending;
}

export function closePendingHttpRelayRequests(session: HttpRelayStreamSession, reason: string): void {
  for (const requestId of Array.from(session.pendingRequests.keys())) {
    const pending = removePendingHttpRelayRequest(session, requestId);
    if (!pending) continue;
    failRelayHttpResponse(pending.response, 502, reason);
  }
}

export function startRelayHttpResponse(
  pending: PendingHttpRelayRequest,
  payload: JsonRecord,
): { ok: true } | { ok: false; error: string } {
  if (pending.response.headersSent) return { ok: true };

  const status = typeof payload.status === 'number'
    && Number.isInteger(payload.status)
    && payload.status >= 100
    && payload.status <= 599
    ? payload.status
    : 502;
  const headers = sanitizeRelayOutgoingHeaders(payload.headers);
  pending.response.status(status);
  pending.response.setHeader('Cache-Control', 'private, no-store');

  try {
    for (const [name, values] of headers) {
      pending.response.setHeader(name, values.length === 1 ? values[0] : values);
    }
  } catch (error) {
    if (!pending.response.headersSent) {
      pending.response.status(502).json({ error: 'Relay server response headers were invalid' });
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown header error',
    };
  }

  pending.started = true;
  return { ok: true };
}

export function writeRelayHttpResponseBody(pending: PendingHttpRelayRequest, payload: JsonRecord): void {
  if (pending.response.writableEnded) return;

  const data = typeof payload.data === 'string' ? payload.data : '';
  const chunk = payload.encoding === 'base64' ? Buffer.from(data, 'base64') : data;
  pending.response.write(chunk);
}

export function endPendingHttpRelayRequest(session: HttpRelayStreamSession, requestId: string): void {
  const pending = removePendingHttpRelayRequest(session, requestId);
  if (!pending) return;
  if (!pending.response.writableEnded) pending.response.end();
}

export function failPendingHttpRelayRequest(
  session: HttpRelayStreamSession,
  requestId: string,
  message: string,
): void {
  const pending = removePendingHttpRelayRequest(session, requestId);
  if (!pending) return;
  failRelayHttpResponse(pending.response, 502, message);
}

function timeoutPendingHttpRelayRequest(session: HttpRelayStreamSession, requestId: string): void {
  const pending = session.pendingRequests.get(requestId);
  if (!pending) return;
  session.pendingRequests.delete(requestId);
  failRelayHttpResponse(pending.response, 504, 'Relay HTTP request timed out');
}

function failRelayHttpResponse(response: RelayHttpResponseLike, status: number, message: string): void {
  if (!response.headersSent) {
    response.status(status).json({ error: message });
  } else if (!response.writableEnded) {
    response.end();
  }
}
