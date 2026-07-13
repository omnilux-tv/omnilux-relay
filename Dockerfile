FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS base

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate && \
    apt-get update && \
    apt-get install -y --no-install-recommends tini curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS builder

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

COPY --from=omnilux-packages package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json /omnilux-packages/
COPY --from=omnilux-packages packages/types /omnilux-packages/packages/types
COPY --from=omnilux-packages packages/api-contracts /omnilux-packages/packages/api-contracts
COPY --from=omnilux-packages scripts /omnilux-packages/scripts
RUN cd /omnilux-packages && pnpm install --frozen-lockfile && pnpm --filter @omnilux/types build && pnpm --filter @omnilux/api-contracts build
RUN node -e "const fs=require('node:fs'); const file='/omnilux-packages/packages/api-contracts/package.json'; const pkg=JSON.parse(fs.readFileSync(file,'utf8')); pkg.dependencies['@omnilux/types']='file:/omnilux-packages/packages/types'; fs.writeFileSync(file, JSON.stringify(pkg,null,2)+'\n');"

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN node -e "const fs=require('node:fs'); const file='package.json'; const pkg=JSON.parse(fs.readFileSync(file,'utf8')); pkg.dependencies['@omnilux/api-contracts']='file:/omnilux-packages/packages/api-contracts'; fs.writeFileSync(file, JSON.stringify(pkg,null,2)+'\n');"
RUN pnpm install --no-frozen-lockfile && test -x node_modules/.bin/tsc

COPY src ./src

RUN pnpm build

FROM base AS runtime

ARG RELAY_VERSION=0.1.0
ARG RELAY_REVISION=unknown
ARG OMNILUX_PACKAGES_REVISION=unknown

LABEL org.opencontainers.image.title="OmniLux Relay" \
      org.opencontainers.image.description="OmniLux remote relay runtime" \
      org.opencontainers.image.version="${RELAY_VERSION}" \
      org.opencontainers.image.revision="${RELAY_REVISION}" \
      org.opencontainers.image.source="https://github.com/omnilux-tv/omnilux-relay" \
      org.opencontainers.image.base.name="docker.io/library/node:22-bookworm-slim" \
      org.opencontainers.image.base.digest="sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf" \
      org.opencontainers.image.licenses="LicenseRef-OmniLux-Customer-License" \
      tv.omnilux.omnilux-packages.revision="${OMNILUX_PACKAGES_REVISION}"

WORKDIR /app

COPY --from=builder /omnilux-packages /omnilux-packages

COPY package.json pnpm-lock.yaml ./
RUN node -e "const fs=require('node:fs'); const file='package.json'; const pkg=JSON.parse(fs.readFileSync(file,'utf8')); pkg.dependencies['@omnilux/api-contracts']='file:/omnilux-packages/packages/api-contracts'; fs.writeFileSync(file, JSON.stringify(pkg,null,2)+'\n');"
RUN HUSKY=0 pnpm install --prod --no-frozen-lockfile --ignore-scripts && pnpm store prune

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
