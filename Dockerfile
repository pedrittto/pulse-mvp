# ---------- build stage ----------
FROM node:22-slim AS builder
WORKDIR /app

# Enable Corepack and pin pnpm 9 (use the version from package.json)
RUN corepack enable

# Copy full repo (monorepo) for a straightforward workspace install
COPY . .

# Activate the version from package.json's "packageManager"
RUN corepack prepare --activate

# Install all workspaces with a frozen lockfile
RUN pnpm -w install --frozen-lockfile

# Build backend only (tsconfig lives in backend/)
RUN pnpm -C backend build

# Optionally prune to production deps for backend
RUN pnpm -C backend install --prod --frozen-lockfile

# ---------- runtime stage ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy only what's needed to run backend
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/package.json ./backend/package.json
COPY --from=builder /app/backend/node_modules ./backend/node_modules

# Fly will forward to this port; keep in sync with fly.toml
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/backend
CMD ["node","dist/index.js"]


