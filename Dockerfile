FROM node:22-bookworm-slim AS base

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate && \
    apt-get update && \
    apt-get install -y --no-install-recommends tini curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

COPY --from=omnilux-packages package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json /omnilux-packages/
COPY --from=omnilux-packages packages/types /omnilux-packages/packages/types
COPY --from=omnilux-packages packages/api-contracts /omnilux-packages/packages/api-contracts
RUN cd /omnilux-packages && pnpm install --frozen-lockfile && pnpm --filter @omnilux/types build && pnpm --filter @omnilux/api-contracts build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN node -e "const fs=require('node:fs'); const file='pnpm-workspace.yaml'; const source=fs.readFileSync(file,'utf8'); if (!source.includes('  - \".\"')) fs.writeFileSync(file, source.trimEnd() + '\n  - \".\"\n');"
RUN pnpm install --include-workspace-root --frozen-lockfile

COPY src ./src

RUN pnpm build

FROM base AS runtime

LABEL org.opencontainers.image.title="OmniLux Relay" \
      org.opencontainers.image.description="OmniLux remote relay runtime" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.source="https://github.com/omnilux-tv/omnilux-relay" \
      org.opencontainers.image.licenses="LicenseRef-OmniLux-Customer-License"

WORKDIR /app

COPY --from=builder /omnilux-packages /omnilux-packages

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN node -e "const fs=require('node:fs'); const file='pnpm-workspace.yaml'; const source=fs.readFileSync(file,'utf8'); if (!source.includes('  - \".\"')) fs.writeFileSync(file, source.trimEnd() + '\n  - \".\"\n');"
RUN pnpm install --include-workspace-root --prod --frozen-lockfile && pnpm store prune

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
