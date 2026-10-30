FROM node:22-bookworm-slim AS workspace

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.34.5
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/client-sdk/package.json packages/client-sdk/package.json
COPY packages/e2e/package.json packages/e2e/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM workspace AS packaged
RUN pnpm --filter @utexo/lightsdk-gateway --fail-if-no-match deploy --prod --legacy /out \
    && mkdir -p /out/dist \
    && cp -a packages/gateway/dist/. /out/dist/

FROM node:22-bookworm-slim AS runtime
# Keep the system trust store available in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && test -s /etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.source="https://github.com/UTEXO-Protocol/lightsdk-gateway"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=packaged /out ./
# Verify the native SQLite dependency after relocating the production package.
RUN node -e "new (require('better-sqlite3'))(':memory:').close()"
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8480)+'/v1/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
