# omnilux-relay

Standalone relay runtime for `relay.omnilux.tv`.

This repo owns the remote-access transport layer only:

- server tunnel registration
- session attachment and frame forwarding
- relay heartbeat handling
- health checks for public edge

It does not own billing, auth UI, entitlements, or durable control-plane state. Those remain in `omnilux-cloud`.

## Development

```bash
pnpm install
pnpm dev
```

## Checks

```bash
pnpm lint
pnpm build
```

## Runtime contract

- `RELAY_PORT` defaults to `8090`
- `RELAY_CONTROL_URL` defaults to `https://api.omnilux.tv/functions/v1`
- `relay.omnilux.tv` is the public ingress owned by `omnilux-edge`

The canonical edge-consumed artifact is `ghcr.io/omnilux-tv/omnilux-relay-runtime`.

## Relay health contract

The relay now emits a normalized `relayCondition` value in relay-owned logs, heartbeat payloads, and close messages.

Valid values:

- `connected` — tunnel is registered and healthy
- `degraded` — partial impairment, but no evidence of auth/revocation/expiry/unreachable
- `unauthorized` — missing/invalid bearer, token rejected by auth checks
- `expired` — token/session time invalid
- `revoked` — token/session intentionally invalidated
- `unreachable` — control-plane or tunnel path unavailable

Evidence mapping:

- `register-relay-connection`
  - success => `connected`
  - HTTP 401/403 or auth-style error => `unauthorized`
  - explicit expiry wording/status => `expired`
  - explicit revocation wording/status => `revoked`
  - fetch/network error or hard control-plane errors => `unreachable`
  - other non-success responses => `degraded`

- `relay-heartbeat`
  - success => `connected`
  - intermittent heartbeat failure with active socket => `degraded`
  - control-plane timeout/network/errors => `unreachable`
  - auth/revocation/expiry signals => matching terminal state

- `consume-relay-session` / attach
  - success + active tunnel => `connected`
  - missing tunnel => `unreachable`
  - explicit expired/revoked/unauthorized signals => respective terminal state
  - runtime attach/internal forwarding issues => `degraded`

- socket close/error and session teardown
  - closure uses consistent reason text: `Relay condition <state> (<reasonCode>): ...`
  - `session-close` messages include `relayCondition` and `reasonCode`

Control-plane compatibility:

- `relayStatus` remains a compatibility string (`online` / `degraded`), while `relayCondition` + `reasonCode` carries the canonical enum.
