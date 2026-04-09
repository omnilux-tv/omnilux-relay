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
