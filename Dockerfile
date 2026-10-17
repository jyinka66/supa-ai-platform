# syntax=docker/dockerfile:1.7

# ============ BUILDER ============
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable

# Copy workspace manifests first for better layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json turbo.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
COPY packages/jobs/package.json ./packages/jobs/package.json

RUN pnpm install --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Build only the deployable app + its workspace deps.
RUN pnpm turbo build --filter=@supa/web...

# ============ RUNNER ============
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user for security.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
