# Commission Escrow — standalone service.
# One Bun process serves the built client + API from one origin.
FROM oven/bun:1

WORKDIR /app

# Dependencies first (layer caching). bun.lock is committed; install frozen.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Source, then build the client bundle (server runs from TypeScript
# directly under Bun; migrations + seed read files from the tree).
COPY . .
RUN bun run build:client

ENV NODE_ENV=production
EXPOSE 3000

# Migrations apply idempotently on boot (RUN_MIGRATIONS=0 to disable).
# The entrypoint optionally seeds demo content first (SEED_DEMO_ON_BOOT=1,
# first deploy only — see scripts/docker-start.sh and DEPLOY.md).
CMD ["sh", "scripts/docker-start.sh"]
