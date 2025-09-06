# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Pin pnpm
ARG PNPM_VERSION=9.5.1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Cache deps
COPY pnpm-lock.yaml package.json ./
COPY backend/package.json ./backend/package.json
RUN pnpm -C backend install --frozen-lockfile

# Build TS
COPY backend ./backend
RUN pnpm -C backend build

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ARG PNPM_VERSION=9.5.1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

ENV NODE_ENV=production
ENV PORT=8080

# Copy runtime artifacts
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/node_modules ./node_modules

EXPOSE 8080
CMD ["node", "dist/index.js"]


