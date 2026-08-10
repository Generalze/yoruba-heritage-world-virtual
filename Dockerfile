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

# EVERYTHING A REAL RENDER NEEDS, BAKED IN AT BUILD TIME.
#
#   ffmpeg    provides ffprobe. The renderer MEASURES approved audio
#             with it before building a timeline, and refuses to plan
#             from database metadata alone — so this is not optional
#             tooling, it is part of the render contract.
#   chromium  the headless browser the compositor drives. Installed from
#             the distribution rather than downloaded by Remotion on
#             first use: a download at the moment of somebody's paid
#             render is a failure waiting for the worst possible time,
#             and it needs a writable cache the container user may not
#             have. REMOTION_BROWSER_EXECUTABLE names it explicitly, and
#             the renderer passes that path to Remotion rather than
#             letting it provision its own.
#   fonts     without them the browser renders nothing legible.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      chromium \
      ca-certificates \
      fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
ENV FFPROBE_PATH=/usr/bin/ffprobe
ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium

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
COPY --from=build /app/scripts ./scripts

# THE SHARED MEDIA PATH, CREATED AND OWNED BEFORE THE USER DROPS.
# Both processes mount the media_data volume here and BOTH write to it:
# the app stores approved media, the worker writes render artifacts. A
# path that only root can write is a worker that cannot render, so it is
# created and chowned at build time rather than hoped for at runtime.
# Docker propagates this ownership into a fresh named volume.
RUN mkdir -p /app/var/media \
 && chown -R bun:bun /app/var

EXPOSE 3000
USER bun
# Bun forwards SIGTERM to the process, and both entry points drain on
# it: the web server finishes in-flight requests, the worker finishes
# its current pipeline pass and closes the pool.
STOPSIGNAL SIGTERM
CMD ["bun", "server.ts"]
