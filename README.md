# Supa AI

A Bun + Turborepo monorepo with a Next.js app, shared UI library, local Supabase stack, and CI checks for type safety, unit tests, and production builds.

## Quickstart

```sh
git clone git@github.com:org/supa-ai.git && cd supa-ai
bun run setup
bun run dev
```

- Local Supabase: http://localhost:54323 (studio) · App: http://localhost:3000
- Storybook: `bun run --filter @supa/ui storybook`

## Prerequisites

- Node.js `>=20.11.0`
- Bun `>=1.1.0`
- Docker (for local Supabase stack and isolated runtime execution)
- Supabase CLI (for local database start/reset commands)

## Workspace Layout

```
supa-ai/
├── apps/                    # Deployable applications
├── packages/
│   ├── config/              # Shared ESLint, Prettier, tsconfig presets
│   ├── tsconfig/            # TypeScript config variants (base, nextjs, react-library)
│   ├── ui/                  # Component library
│   └── …                    # Other shared packages
├── .github/workflows/       # CI: lint, typecheck, unit tests, build
├── scripts/                 # Migration sync, local env generation, migration templates
├── supabase/config.toml     # Local Supabase stack configuration
├── infra/docker-compose.yml # Optional standalone Postgres + Redis
├── turbo.json               # Pipeline definition (build / dev / lint / test / typecheck)
└── package.json workspaces  # Workspace globs
```

## Common Scripts

| Script | Purpose |
| --- | --- |
| `bun run dev` | Run all apps in parallel via Turbo |
| `bun run build` | Build all packages and apps |
| `bun run lint` | Run ESLint across the workspace |
| `bun run typecheck` | Type-check without emitting |
| `bun run test` | Unit tests (Vitest) |
| `bun run test:e2e` | End-to-end tests (Playwright) |
| `bun run db:generate -- add_feature` | Create the next numbered SQL migration template |
| `bun run db:migrate` | Sync migrations and apply pending migrations to local Supabase |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run supabase:start` | Sync SQL files and boot the local Supabase stack |
| `bun run supabase:reset` | Reapply all migrations to the local DB (destructive reset) |
| `bun run supabase:types` | Regenerate Supabase TypeScript types |
| `bun run dev:env` | Generate `apps/web/.env.local` from local Supabase keys |
| `bun run sync:migrations` | Copy numbered SQL migrations into Supabase's timestamped format |
| `bun run setup` | Install dependencies, start Supabase, create local env, reset DB, generate types |

## Environment

`bun run setup` generates `apps/web/.env.local` using the actual keys reported by the local Supabase CLI. For manual setup, copy `.env.example` to both the repository-root `.env` and `apps/web/.env.local`, then replace placeholder keys. Never commit local environment files. Required keys:

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase client
- `SUPABASE_SERVICE_ROLE_KEY` — server-only Supabase access
- `DATABASE_URL` — direct Postgres connection
- `SUPABASE_JWT_SECRET` — server-side JWT verification
- `SENSITIVE_DATA_ENCRYPTION_KEY` — 32-byte hex key for AES-256-GCM sensitive fields
- `SENTRY_DSN` / `SENTRY_AUTH_TOKEN` — optional error tracking + source maps
- `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` — product analytics
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — required for production rate limiting (local development may leave these blank)
- `TURBO_TOKEN` / `TURBO_TEAM` — remote caching (CI only)

## CI

`.github/workflows/ci.yml` runs on pushes to `main`/`master` and on pull requests. It installs dependencies with Bun's frozen lockfile, then runs workspace linting, type checking, unit tests, and a production build. Full local Supabase integration tests require the Supabase CLI and Docker and are not currently part of this workflow.

## Isolated command runtime

The Supa OS command API executes each command in a disposable Docker container; it never evaluates submitted shell commands on the Next.js host. Install Docker on the application host and preload the runtime images before enabling the API (the API uses `--pull=never`):

```sh
docker pull node:20-alpine
docker pull python:3.12-alpine
docker pull golang:1.23-alpine
docker pull rust:1.82-alpine
docker pull denoland/deno:alpine
docker pull oven/bun:alpine
docker pull postgres:16-alpine
```

Each run has no network access, a read-only root filesystem, a non-root UID, CPU/memory/PID limits, a 2 MiB workspace cap, bounded output and a 60-second maximum timeout. Provide project files using the `files` array in the execution request. Because network access is disabled, dependency installation must be prepared in the workspace or baked into a separately reviewed runtime image. Runtime images can be overridden with `SUPA_OS_NODE_IMAGE`, `SUPA_OS_PYTHON_IMAGE`, `SUPA_OS_GO_IMAGE`, `SUPA_OS_RUST_IMAGE`, `SUPA_OS_DENO_IMAGE`, `SUPA_OS_BUN_IMAGE`, and `SUPA_OS_POSTGRES_IMAGE`. SQL migrations are validated in a temporary PostgreSQL instance; they do not alter the application's configured database.

Sensitive-field encryption uses AES-256-GCM. Configure `SENSITIVE_DATA_ENCRYPTION_KEY` as a 64-character hexadecimal server secret; clients cannot provide or override this key.
