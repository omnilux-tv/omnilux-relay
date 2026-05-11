# omnilux-relay

Standalone relay runtime for `relay.omnilux.tv`.

## Workspace

This repository is part of the official OmniLux multi-repo workspace. Use the root `omnilux-workspace` repo for onboarding, profiles, and cross-repo contracts:

- Onboarding: `../ONBOARDING.md`
- Manifest: `../workspace.repositories.json`
- Contracts: `../contracts/`

This repo owns the remote-access transport layer only:

- server tunnel registration
- session attachment and frame forwarding
- relay heartbeat handling
- health checks for public edge

It does not own billing, auth UI, entitlements, or durable control-plane state. Those remain in `omnilux-cloud`.

## Canonical Contracts

- Relay execution plan: `../contracts/relay-contract-plan.md`
- Detailed relay boundary: `../omnilux/docs/relay/relay-control-plane-boundary.md`
- Shared agent contract: `../contracts/agent-contracts-plan.md`

Transport changes that alter token, tunnel, session, heartbeat, or condition semantics must update the detailed relay boundary and the relay contract plan in the same change.

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
- `RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL` enables local verification for signed
  `olrg_` relay grants issued by `omnilux-cloud`
- `RELAY_GRANT_AUDIENCE` defaults to `relay.omnilux.tv`
- `RELAY_REQUIRE_SIGNED_SESSION_GRANTS=true` rejects legacy opaque `olrs_`
  session tokens after migration is complete

The canonical edge-consumed artifact is `ghcr.io/omnilux-tv/omnilux-relay-runtime`.

## Relay health contract

The relay emits a transport-level `relayCondition` value in relay-owned logs, heartbeat payloads, and close messages. Product surfaces should map these transport conditions to the product-level relay condition vocabulary defined in `../omnilux/docs/relay/relay-control-plane-boundary.md`.

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

Product condition mapping:

| Transport condition | Product condition |
| --- | --- |
| `connected` | `online` |
| `degraded` | `degraded` |
| `unauthorized` | `not_configured` or `not_entitled`, depending on control-plane reason |
| `expired` | `waiting_for_tunnel` or `offline`, depending on whether the server can refresh |
| `revoked` | `not_entitled` or `not_configured`, depending on revocation reason |
| `unreachable` | `waiting_for_tunnel` or `offline`, depending on whether a tunnel was previously established |

The relay should not invent user-facing copy. Cloud/local UI maps product conditions to trust vocabulary.
