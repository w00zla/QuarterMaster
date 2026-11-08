# One image for the bot, both web apps and the one-off tasks (migrations, command
# registration); the compose service's command picks the process. No build step for the
# backend: Node runs the .ts files directly. Only the SPAs are built.
ARG NODE_IMAGE=docker.io/library/node:26-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm in der Version aus package.json ("packageManager"); per npm statt corepack: pnpm ≥ 11 ist
# eine native Binary aus einer optionalen Abhängigkeit (@pnpm/exe.<os>), die corepack nicht mitlädt
RUN npm install -g "$(node -p "require('./package.json').packageManager")"
COPY adminapp/package.json adminapp/
COPY webapp/package.json webapp/

# All dependencies incl. dev, to build the SPAs (they import shared code from src/, the web app also
# from adminapp/src)
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY src src
COPY adminapp adminapp
COPY webapp webapp
RUN pnpm adminapp:build && pnpm webapp:build

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
COPY --from=build /app/adminapp/dist adminapp/dist
COPY --from=build /app/webapp/dist webapp/dist
USER node
