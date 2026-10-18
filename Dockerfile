# syntax=docker/dockerfile:1
ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js standalone server + static assets. The public folder is not copied
# into .next/standalone by the framework, so both steps are required.
RUN npm run build \
 && mkdir -p tools \
 && ./node_modules/.bin/esbuild scripts/migrate.ts --bundle --platform=node --format=esm --outfile=tools/migrate.mjs --external:pg --external:dotenv --tsconfig=tsconfig.json \
 && ./node_modules/.bin/esbuild scripts/seed.ts --bundle --platform=node --format=esm --outfile=tools/seed.mjs --external:pg --external:dotenv --tsconfig=tsconfig.json \
 && ./node_modules/.bin/esbuild scripts/init-installation.ts --bundle --platform=node --format=esm --outfile=tools/init.mjs --external:pg --external:dotenv --tsconfig=tsconfig.json \
 && ./node_modules/.bin/esbuild scripts/create-user.ts --bundle --platform=node --format=esm --outfile=tools/create-user.mjs --external:pg --external:dotenv --tsconfig=tsconfig.json \
 && cp deploy/wait-for-db.mjs tools/wait-for-db.mjs \
 && cp -r public .next/standalone/public \
 && mkdir -p .next/standalone/.next \
 && cp -r .next/static .next/standalone/.next/static

FROM node:${NODE_VERSION} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    TZ=Europe/Moscow

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 salonit \
 && useradd --system --uid 1001 --gid salonit --home-dir /app --shell /usr/sbin/nologin salonit

WORKDIR /app
COPY --from=builder --chown=salonit:salonit /app/.next/standalone ./
COPY --from=builder --chown=salonit:salonit /app/.next/static ./.next/static
COPY --from=builder --chown=salonit:salonit /app/public ./public
COPY --from=builder --chown=salonit:salonit /app/tools ./tools
COPY --from=builder --chown=salonit:salonit /app/migrations ./migrations
COPY --from=builder --chown=salonit:salonit /app/deploy/entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh
USER salonit
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
