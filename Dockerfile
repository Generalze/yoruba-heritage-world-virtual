# Yorùbá Heritage World Virtual — ONE application image (Bun)
#
# Build:  docker compose build   (or: docker build -t yhwv-app .)
#
# ONE IMAGE, TWO PROCESSES. The web server and the generation worker are
# separate CONTAINERS run from this SAME image at the SAME revision,
# differing only in their command. Two independently-built images would
# be two independently-drifting versions of the pipeline, and a worker
# a commit behind the app is a worker enforcing last week's governance.
#
# No secrets are baked in: configuration arrives from the environment at
# runtime (see .env.example and docker-compose.yml). Dependencies are
# installed with a frozen lockfile so the image is reproducible.

# ---- Build stage ----
FROM oven/bun:1.3 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ---- Production dependencies ----
FROM oven/bun:1.3 AS prod-deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- Runtime stage ----
FROM oven/bun:1.3-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
# THE WORKER RUNS FROM SOURCE, so the whole of src/ ships — not just the
# static-path helper the web entry needs. Before Step 20 this image
# carried src/lib only, which meant `bun run worker:generation` could
# not resolve a single service and the worker service in Compose was a
# commented-out aspiration. The worker needs the services, the
# providers, the schema and the Remotion composition; the web server
# needs the compiled bundle in dist/ plus the same helpers.
COPY --from=build /app/src ./src
# Migrations travel WITH the image, so the exact schema a revision
# expects is always present for the operator migration command. They are
# NEVER applied automatically at boot or at request time — see the
# runbook.
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

EXPOSE 3000
USER bun
# Bun forwards SIGTERM to the process, and both entry points drain on
# it: the web server finishes in-flight requests, the worker finishes
# its current pipeline pass and closes the pool.
STOPSIGNAL SIGTERM
CMD ["bun", "server.ts"]
