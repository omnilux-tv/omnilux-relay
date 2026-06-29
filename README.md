# omnilux-relay

Standalone relay runtime for `relay.omnilux.tv`.

## Workspace

This repository is part of the official OmniLux multi-repo workspace. Use the root `omnilux-workspace` repo for onboarding, profiles, and cross-repo contracts:

- Onboarding: `../ONBOARDING.md`
- Manifest: `../workspace.repositories.json`
- Contracts: `../contracts/`
- Context: `./CONTEXT.md`

This repo owns the remote-access transport layer only:

- server tunnel registration
- session attachment and frame forwarding
- browser HTTP relay handoff at `/r/<relay-session-token>/`
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
pnpm dev:worker
```

## Checks

```bash
pnpm lint
pnpm lint:worker
pnpm build
```

## Runtime contract

This repo ships two relay runtimes:

- `src/index.ts` is the Node/VPS relay runtime currently consumed by the public edge.
- `src/cloudflare/index.ts` is the Cloudflare Worker + Durable Object relay runtime for the first global relay layer.

Both runtimes preserve the same tunnel/session protocol:

- self-hosted servers connect to `/ws/server` and register a tunnel with a relay tunnel token
- cloud-created browser/client sessions connect through `/ws/session` or `/r/<relay-session-token>/`
- relay sessions are consumed through `omnilux-cloud`
- active server tunnels receive `session-open`, `session-frame`, and `session-close`
- browser HTTP relay traffic is forwarded as `http-request` frames and returned as `http-response-*` frames

- `RELAY_PORT` defaults to `8090`
- `RELAY_CONTROL_URL` defaults to `https://api.omnilux.tv/functions/v1`
- `relay.omnilux.tv` is the public ingress owned by `omnilux-edge`
- `RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL` is required for local verification of
  signed `olrg_` relay grants issued by `omnilux-cloud`
- `RELAY_GRANT_AUDIENCE` defaults to `relay.omnilux.tv`
- Signed session grants are required by default. `RELAY_ALLOW_LEGACY_SESSION_GRANTS=true`
  is a temporary migration-only override for legacy opaque `olrs_` session tokens.
- `RELAY_HTTP_SESSION_COOKIE` defaults to `omnilux_relay_session`
- `RELAY_HTTP_SESSION_TTL_MS` defaults to four hours
- `RELAY_HTTP_REQUEST_TIMEOUT_MS` defaults to ten minutes
- `RELAY_HTTP_REQUEST_BODY_MAX_BYTES` defaults to 25 MiB

The canonical edge-consumed artifact is `ghcr.io/omnilux-tv/omnilux-relay-runtime`.

## Cloudflare Worker relay

The Worker deploy target is configured in `wrangler.jsonc`.

```bash
pnpm lint:worker
pnpm build:worker
pnpm deploy:worker
```

Required Cloudflare secret:

```bash
pnpm wrangler secret put RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL --config wrangler.jsonc
```

Required GitHub Actions secrets for `.github/workflows/cloudflare-worker-deploy.yml`:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OMNILUX_PACKAGES_DEPLOY_KEY`

The Durable Object binding is `RELAY_COORDINATOR`. The first deployment uses one
named coordinator object (`RELAY_COORDINATOR_NAME=global`) so server tunnels and
session attachment meet in the same hibernation-aware coordination point. This
is the first production-shaped Cloudflare relay layer; future sharding should
route by a stable server key once tunnel URLs or control-plane rendezvous carry
that key before registration.

Cloudflare TURN/WebRTC credentials are intentionally separate from this runtime.
TURN is for NAT/firewall traversal on WebRTC-style paths, while this Worker
implements the current WebSocket and browser HTTP relay contract.

## Browser HTTP relay

The hosted app opens browser remote access by creating a cloud relay session and
navigating the user to:

```text
https://relay.omnilux.tv/r/<relay-session-token>/
```

The relay consumes the short-lived cloud token, binds the browser to an internal
HTTP-only session cookie, and redirects to `/`. Subsequent browser requests to
`relay.omnilux.tv` are framed over the live server tunnel as `http-request`
messages. The self-hosted runtime responds with streamed
`http-response-start`, `http-response-body`, and `http-response-end` frames.
This keeps the cloud token out of asset URLs after the initial handoff and lets
normal absolute runtime paths such as `/assets/...` and `/api/...` work through
the relay origin.

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
