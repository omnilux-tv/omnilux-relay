import type { ConsumedRelaySession } from './relay-control-plane.js';
import type { PendingHttpRelayRequest } from './relay-http-stream.js';

export interface HttpRelaySession {
  handle: string;
  sessionId: string;
  serverId: string;
  userId?: string;
  sessionType: string;
  tunnelConnectionId: string;
  openedAt: string;
  lastSeenAt: string;
  expiresAt: number;
  pendingRequests: Map<string, PendingHttpRelayRequest>;
}

export interface RelayHttpSessionStore {
  add(session: HttpRelaySession): void;
  remove(session: HttpRelaySession): void;
  getByHandle(handle: string): HttpRelaySession | undefined;
  getBySessionId(sessionId: string): HttpRelaySession | undefined;
  values(): IterableIterator<HttpRelaySession>;
}

export function createRelayHttpSessionStore(): RelayHttpSessionStore {
  const sessionsByHandle = new Map<string, HttpRelaySession>();
  const sessionsById = new Map<string, HttpRelaySession>();

  return {
    add(session) {
      sessionsByHandle.set(session.handle, session);
      sessionsById.set(session.sessionId, session);
    },
    remove(session) {
      sessionsByHandle.delete(session.handle);
      sessionsById.delete(session.sessionId);
    },
    getByHandle(handle) {
      return sessionsByHandle.get(handle);
    },
    getBySessionId(sessionId) {
      return sessionsById.get(sessionId);
    },
    values() {
      return sessionsByHandle.values();
    },
  };
}

export function createHttpRelaySessionRecord(input: {
  handle: string;
  consumedSession: ConsumedRelaySession;
  tunnelConnectionId: string;
  ttlMs: number;
  now?: Date;
}): HttpRelaySession {
  const now = input.now ?? new Date();
  const cloudExpiresAt = input.consumedSession.expiresAt ? Date.parse(input.consumedSession.expiresAt) : NaN;
  const localExpiresAt = now.getTime() + input.ttlMs;
  const openedAt = now.toISOString();

  return {
    handle: input.handle,
    sessionId: input.consumedSession.sessionId,
    serverId: input.consumedSession.serverId,
    userId: input.consumedSession.userId,
    sessionType: input.consumedSession.sessionType,
    tunnelConnectionId: input.tunnelConnectionId,
    openedAt,
    lastSeenAt: openedAt,
    expiresAt: Number.isFinite(cloudExpiresAt) ? Math.min(localExpiresAt, cloudExpiresAt) : localExpiresAt,
    pendingRequests: new Map(),
  };
}

export function findHttpRelaySessionFromCookie(input: {
  cookieHeader: string | undefined;
  cookieName: string;
  store: RelayHttpSessionStore;
  onExpired: (session: HttpRelaySession) => void;
  now?: Date;
}): HttpRelaySession | null {
  const handle = parseCookies(input.cookieHeader)[input.cookieName];
  if (!handle) return null;

  const session = input.store.getByHandle(handle);
  if (!session) return null;

  const now = input.now ?? new Date();
  if (session.expiresAt <= now.getTime()) {
    input.onExpired(session);
    return null;
  }

  session.lastSeenAt = now.toISOString();
  return session;
}

export function closeExpiredHttpRelaySessions(
  store: RelayHttpSessionStore,
  closeSession: (session: HttpRelaySession, reason: string) => void,
  now = new Date(),
): void {
  for (const session of Array.from(store.values())) {
    if (session.expiresAt <= now.getTime()) {
      closeSession(session, 'Relay HTTP session expired');
    }
  }
}

export function relaySessionCookie(input: {
  cookieName: string;
  handle: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string {
  const secure = input.secure ? '; Secure' : '';
  return `${input.cookieName}=${encodeURIComponent(input.handle)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${input.maxAgeSeconds}${secure}`;
}

export function clearRelaySessionCookie(input: {
  cookieName: string;
  secure: boolean;
}): string {
  const secure = input.secure ? '; Secure' : '';
  return `${input.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

export function relaySessionMaxAgeSeconds(expiresAt: number, now = new Date()): number {
  return Math.max(60, Math.floor((expiresAt - now.getTime()) / 1000));
}

export function relayHandoffRedirectTarget(originalUrl: string, pathAfterToken = '/'): string {
  const search = new URL(originalUrl, 'http://relay.local').search;
  return `${pathAfterToken || '/'}${search}` || '/';
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  for (const segment of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = segment.trim().split('=');
    if (!rawName || rawValue.length === 0) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join('='));
  }

  return cookies;
}
