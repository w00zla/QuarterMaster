# One image for the bot, the admin web UI and the one-off tasks (migrations, command
# registration); the compose service's command picks the process. No build step for the
# backend: Node runs the .ts files directly. Only the SPA is built.
ARG NODE_IMAGE=docker.io/library/node:22-slim

FROM ${NODE_IMAGE} AS base
# pnpm in the version from package.json ("packageManager")
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/

# All dependencies incl. dev, to build the SPA (it imports shared code from src/)
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY src src
COPY web web
RUN pnpm web:build

# Runtime dependencies of the backend only
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter sc-quartermaster

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# package.json is needed at runtime: "type": "module" decides how the .ts files are loaded
COPY package.json ./
COPY --from=deps /app/node_modules node_modules
COPY src src
COPY drizzle drizzle
COPY --from=build /app/web/dist web/dist
USER node
