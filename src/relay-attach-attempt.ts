const RELAY_ATTACH_ATTEMPT_DOMAIN = 'omnilux-relay-attach-v1\0';
const RELAY_SESSION_CONNECTION_DOMAIN = 'omnilux-relay-connection-v1\0';

export async function deriveRelayAttachAttemptId(token: string): Promise<string> {
  return `raa_${await domainSeparatedTokenHash(RELAY_ATTACH_ATTEMPT_DOMAIN, token)}`;
}

export async function deriveRelaySessionConnectionId(token: string): Promise<string> {
  return `rcn_${await domainSeparatedTokenHash(RELAY_SESSION_CONNECTION_DOMAIN, token)}`;
}

async function domainSeparatedTokenHash(domain: string, token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${domain}${token}`),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
