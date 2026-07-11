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
pnpm test:worker-smoke
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
- each consume includes a token-derived, domain-separated `attachAttemptId`;
  its logical `connectionId` is independently derived from the same token, so
  retries reuse both identifiers and delayed requests cannot overwrite newer
  state or irreversibly burn a one-time grant
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
- `RELAY_HTTP_RESPONSE_BUFFER_MAX_BYTES` bounds unread streamed response data per
  request and defaults to 1 MiB
- `RELAY_RENDEZVOUS_TTL_MS` controls how long a server-to-shard route remains
  valid without registration or heartbeat refresh and defaults to two minutes

The canonical edge-consumed artifact is `ghcr.io/omnilux-tv/omnilux-relay-runtime`.

## Cloudflare Worker relay

Worker configuration is deliberately split by authority:

- `wrangler.jsonc` is local and validation-only. It has no public route.
- `wrangler.staging.jsonc` targets the isolated `relay-test.omnilux.tv/*` route
  and `api-test.omnilux.tv` control plane. Both must be provisioned in the
  non-production test lane before the manual staging workflow is enabled.
- `wrangler.production.jsonc` is the only config allowed to contain
  `relay.omnilux.tv/*`.

```bash
pnpm test:release-config
pnpm lint:worker
pnpm test:worker-smoke
pnpm build:worker
pnpm build:worker:staging
pnpm build:worker:production
```

Every build command above is a Wrangler dry-run and does not mutate Cloudflare
state. There is intentionally no package-level deploy script. Pull requests and
pushes to `main` run `.github/workflows/cloudflare-worker-validate.yml`, which
validates all three configs without deploying. Staging and production promotion
are separate, manual `workflow_dispatch` workflows.

Production promotion requires a full immutable commit SHA, the exact staging
Worker version ID carrying that SHA, an approved existing production rollback
version ID, a change reference, and approval through the `relay-production`
GitHub environment. Configure that environment with required reviewers and
disallow self-review. The workflow verifies the staged SHA/version pair and the
rollback version, captures deployment state before and after promotion, and
rolls back if the production readiness probe fails. No push to `main` deploys
production.

`pnpm test:worker-smoke` runs the Worker/Durable Object parity, load, reconnect,
large-response, bounded-buffer, and cancellation checks locally. It does not
mutate production Cloudflare state. `/readyz` fails closed unless the signed-grant
key is configured and both the coordinator and rendezvous Durable Objects answer
their internal probes.

Guaranteed parity with the Node/VPS relay:

- Both runtimes require signed relay grants by default and consume sessions through `omnilux-cloud`.
- Both runtimes preflight and postcheck the exact live tunnel around consume,
  reject mismatched consume-response attempt bindings, and supersede any prior
  local socket/session returned by an idempotent same-token retry.
- Both runtimes register server tunnels, emit `session-open`, forward WebSocket frames, and proxy browser HTTP traffic as `http-request` / `http-response-*` frames.
- Both runtimes strip relay control cookies before origin forwarding and prevent tunneled origins from replacing the relay session cookie.

Runtime-specific differences:

- The Node/VPS relay owns the container image consumed by `omnilux-edge` and runs Express + `ws`.
- The Cloudflare relay uses a Worker front door, sharded coordinator Durable
  Objects, and a rendezvous Durable Object. A tunnel is placed on a deterministic
  token shard before registration; registration publishes the authoritative
  server-to-shard route. Session grants and HTTP route cookies resolve that route,
  and reconnecting on another shard safely supersedes the prior tunnel.
- Legacy cookies and routes can still fall back to the configured legacy
  coordinator so the Node/VPS path and earlier Worker sessions remain rollback
  compatible during migration.

Required Cloudflare secret in each GitHub deployment environment:

```bash
pnpm wrangler secret put RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL --config wrangler.staging.jsonc
pnpm wrangler secret put RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL --config wrangler.production.jsonc
```

Required GitHub Actions secrets for the manual staging and production workflows:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OMNILUX_PACKAGES_DEPLOY_KEY`

The Durable Object bindings are `RELAY_COORDINATOR` and `RELAY_RENDEZVOUS`.
`RELAY_LEGACY_COORDINATOR_NAME` controls only the compatibility fallback; normal
traffic uses the rendezvous directory and route-bearing session cookie.

HTTP responses are exposed as streams at `http-response-start`; body frames are
not accumulated until `http-response-end`. The per-request bound applies
backpressure and cancels the upstream runtime fetch when the client stops reading,
times out, or exceeds the unread-buffer limit. Cancellation is sent inside the
existing session envelope:

```json
{
  "type": "session-frame",
  "sessionId": "session-id",
  "encoding": "text",
  "data": "{\"type\":\"http-request-cancel\",\"requestId\":\"request-id\",\"reason\":\"...\"}"
}
```

The Node/VPS relay remains the live rollback path. A Worker release is not a
Node image replacement: keep the reviewed Node image digest and edge routing
available until Worker readiness, reconnect, large-response, and cancellation
evidence has been accepted.

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

| Transport condition | Product condition                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `connected`         | `online`                                                                                    |
| `degraded`          | `degraded`                                                                                  |
| `unauthorized`      | `not_configured` or `not_entitled`, depending on control-plane reason                       |
| `expired`           | `waiting_for_tunnel` or `offline`, depending on whether the server can refresh              |
| `revoked`           | `not_entitled` or `not_configured`, depending on revocation reason                          |
| `unreachable`       | `waiting_for_tunnel` or `offline`, depending on whether a tunnel was previously established |

The relay should not invent user-facing copy. Cloud/local UI maps product conditions to trust vocabulary.
