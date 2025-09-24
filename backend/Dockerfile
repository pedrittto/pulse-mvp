# ---- deps ----
FROM node:22-slim AS deps
WORKDIR /app
# Use a project-local pnpm store so we can copy it into the runtime image
ENV PNPM_STORE_DIR=/pnpm/store
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml* ./
# Install deps (prefer lockfile; fall back if missing)
RUN pnpm install --frozen-lockfile || pnpm install

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# ---- runtime ----
FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Keep the same store path used during install so pnpm symlinks resolve
ENV PNPM_STORE_DIR=/pnpm/store
# App artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# pnpm runtime requirements: node_modules + store
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=deps  /pnpm/store      /pnpm/store
# Distroless nodejs image has ENTRYPOINT=node; run our script
CMD ["dist/index.js"]
