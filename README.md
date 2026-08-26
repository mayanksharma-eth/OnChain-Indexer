# Onchain Indexer

Solver-oriented EVM onchain indexer. Currently at the scaffolding stage — no
indexing logic yet.

## Structure

```
apps/
  indexer/    # indexer service (placeholder, not yet implemented)
  api/        # Fastify HTTP API
packages/
  config/     # env loading + validation (zod)
  database/   # Postgres (drizzle) + Redis clients
  types/      # shared types
  abi/        # contract ABIs + viem helpers
  utils/      # shared utilities (logger, etc.)
tests/        # cross-package tests
scripts/      # one-off scripts
```

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
```

## Local infrastructure

`docker-compose.yml` provides PostgreSQL and Redis for local development
(no indexer/API containers — those run with `pnpm dev`).

```bash
docker compose up -d
```

Check both services are healthy:

```bash
docker compose ps
```

`STATUS` should show `healthy` for both `postgres` and `redis`. To check
manually:

```bash
docker compose exec postgres pg_isready -U postgres -d indexer
docker compose exec redis redis-cli ping   # expects PONG
```

Stop the stack (data persists in named volumes):

```bash
docker compose down
```

## Scripts

| Command            | Description                   |
| ------------------ | ----------------------------- |
| `pnpm dev`         | Run the API in watch mode     |
| `pnpm dev:indexer` | Run the indexer placeholder   |
| `pnpm db:generate` | Generate a SQL migration from the schema |
| `pnpm db:migrate`  | Apply pending migrations to `DATABASE_URL` |
| `pnpm build`       | Build all packages and apps   |
| `pnpm test`        | Run the test suite (vitest)   |
| `pnpm typecheck`   | Type-check all workspaces     |
| `pnpm lint`        | Lint all workspaces           |
| `pnpm format`      | Format the repo with prettier |

## Requirements

- Node.js 22+
- pnpm 10+
- PostgreSQL and Redis (see `.env.example`)
