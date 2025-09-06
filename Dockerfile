# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Use corepack to pin pnpm from packageManager (pnpm@9.9.0)
RUN corepack enable && corepack prepare pnpm@9.9.0 --activate

# Cache deps
COPY pnpm-lock.yaml package.json ./
COPY backend/package.json ./backend/package.json
RUN pnpm -C backend install --frozen-lockfile

# Build TS (tsconfig.json is inside backend/)
COPY backend ./backend
RUN pnpm -C backend build

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Runtime artifacts
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/node_modules ./node_modules

EXPOSE 8080
CMD ["node", "dist/index.js"]


