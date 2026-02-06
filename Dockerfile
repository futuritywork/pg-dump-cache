FROM oven/bun:1 AS base
WORKDIR /app

ARG PG_VERSION=18

# Install PostgreSQL client tools for pg_dump
RUN apt-get update && apt-get install -y curl ca-certificates gnupg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y postgresql-client-${PG_VERSION} \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies
FROM base AS install
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Production
FROM base AS production
COPY --from=install /app/node_modules ./node_modules
COPY . .

# Create cache directory
RUN mkdir -p /app/cache

ENV CACHE_DIR=/app/cache
ENV PORT=3000
ENV TTL=3600
ENV KEEP_COUNT=3

EXPOSE 3000

CMD ["bun", "run", "src/server.ts"]
