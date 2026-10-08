# syntax=docker/dockerfile:1
# One image for both processes. API:    node dist/main      Worker: node dist/worker
# Targets: runtime (default, production) | migrate (applies Prisma migrations: `prisma migrate deploy`, never `reset`).

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# `prisma generate` (postinstall) only needs a syntactically valid URL; no connection is made at build time.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM deps AS migrate
ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# The generated Prisma client is compiled into dist/, so no install scripts are needed here.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run with an init process (docker run --init / compose `init: true`) so SIGTERM reaches Node and shutdown hooks run.
CMD ["node", "dist/main"]
