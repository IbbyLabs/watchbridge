# syntax=docker/dockerfile:1

# ---- build stage ----
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# Install with a warm store cache, using only manifests first for better layer reuse.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Produce a self-contained server bundle (workspace deps flattened, prod only),
# then colocate the built SPA so the server can serve it.
RUN pnpm --filter=@watchbridge/server deploy --prod --legacy /prod/app \
  && cp -r packages/web/dist /prod/app/web

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /prod/app /app
# Pre-create the data dir owned by the runtime user so an anonymous volume
# inherits writable ownership.
RUN mkdir -p /app/data && chown node:node /app/data
# Injected from the release tag by CI (falls back to a dev marker locally).
# Kept after the COPY so the per-release app layer busts this layer's cache —
# an ENV placed before the COPY gets served stale from the build cache, baking
# the previous release's version into the new image.
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
