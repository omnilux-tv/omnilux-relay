FROM node:22-bookworm-slim AS base

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate && \
    apt-get update && \
    apt-get install -y --no-install-recommends tini curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src

RUN pnpm build

FROM base AS runtime

LABEL org.opencontainers.image.title="OmniLux Relay" \
      org.opencontainers.image.description="OmniLux remote relay runtime" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.source="https://github.com/omnilux-tv/omnilux-relay" \
      org.opencontainers.image.licenses="LicenseRef-OmniLux-Customer-License"

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production \
    RELAY_PORT=8090 \
    RELAY_CONTROL_URL=https://api.omnilux.tv/functions/v1 \
    RELAY_HEARTBEAT_INTERVAL_MS=30000

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8090/healthz || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
