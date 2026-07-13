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

This repo contains one production relay runtime and one staging-only parity runtime:

- `src/index.ts` is the sole production Node/VPS relay runtime consumed by the public edge.
- `src/cloudflare/index.ts` is a staging-only Cloudflare Worker + Durable Object parity runtime. It has no production route or promotion workflow.

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
- `RELAY_WEBSOCKET_MAX_PAYLOAD_BYTES` bounds every Node/VPS WebSocket message and
  defaults to 1 MiB
- `RELAY_RENDEZVOUS_TTL_MS` controls how long a server-to-shard route remains
  valid without registration or heartbeat refresh and defaults to two minutes

The canonical edge-consumed artifact is `ghcr.io/omnilux-tv/omnilux-relay-runtime`.

### Relay image release evidence

The image workflow is tag-triggered or manually dispatched with a full commit
SHA that is reachable from `main`. It is disabled unless the `RELAY_IMAGE_RELEASE_ENABLED` repository variable
is exactly `true`, and every run is protected by the `relay-production` GitHub
environment.

All relay source gates run before the workflow builds the Linux AMD64 artifact
once into an ephemeral localhost registry. It boots the exact candidate and
requires `/healthz` before registry authentication, then verifies that digest,
requires BuildKit `mode=max`
provenance and a populated SPDX SBOM, and checks the runtime revision, artifact
version, and pinned `omnilux-packages` revision labels before authenticating to
GHCR. It then copies the already-verified digest and attestations to the canonical
repository without rebuilding and verifies every promoted tag resolves to the
same digest. The exact evidence is retained as a workflow artifact. A
full-revision `sha-<40-character-commit>` tag is always created; release tags also
create version and major/minor aliases. Publication is serialized across all
release refs so aliases cannot race backward. The workflow never publishes `latest`.

```bash
pnpm test:image-release
```

## Cloudflare Worker relay

Worker configuration is deliberately staging-only:

- `wrangler.jsonc` is local and validation-only. It has no public route and uses
  only the test control plane and test audience.
- `wrangler.staging.jsonc` targets the isolated `relay-test.omnilux.tv/*` route
  and `api-test.omnilux.tv` control plane. Both must be provisioned in the
  non-production test lane before the manual staging workflow is enabled.
- There is no Worker production config or production promotion workflow during
  the focused household beta. `relay.omnilux.tv` remains on Node/VPS.

```bash
pnpm test:release-config
pnpm lint:worker
pnpm test:worker-smoke
pnpm build:worker
pnpm build:worker:staging
```

Every build command above is a Wrangler dry-run and does not mutate Cloudflare
state. There is intentionally no package-level deploy script. Pull requests and
pushes to `main` run `.github/workflows/cloudflare-worker-validate.yml`, which
validates local and staging configs without deploying. The only Worker deployment
workflow is a manual `workflow_dispatch` to the isolated staging route. No push
to `main` deploys a Worker.

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

Required Cloudflare secret in the staging GitHub deployment environment:

```bash
pnpm wrangler secret put RELAY_GRANT_PUBLIC_KEY_SPKI_B64URL --config wrangler.staging.jsonc
```

Required GitHub Actions secrets for the manual staging workflow:

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

The Node/VPS relay is the only live production path for the focused household
beta. Worker staging evidence can inform a later architecture decision, but it
does not authorize or imply a production cutover.

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
