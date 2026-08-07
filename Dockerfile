# Yorùbá Heritage World Virtual — application image (Bun)
# Build:  docker compose build   (or: docker build -t yhwv-app .)
# No secrets are baked into the image; configuration comes from the
# environment at runtime (see .env.example and docker-compose.yml).

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
# server.ts imports the static-path containment helper at runtime
COPY --from=build /app/src/lib ./src/lib

EXPOSE 3000
USER bun
CMD ["bun", "server.ts"]
