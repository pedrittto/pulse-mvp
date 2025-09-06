# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
# pnpm via corepack (use version from root package.json)
RUN corepack enable && corepack prepare --activate
# deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
# sources
COPY . .
# build TS -> dist/
RUN pnpm run build \
 && mkdir -p dist/metrics dist/ingest \
 && (cp -r src/metrics/*.js dist/metrics/ 2>/dev/null || true) \
 && (cp -r src/ingest/*     dist/ingest/  2>/dev/null || true)

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare --activate
ENV NODE_ENV=production
ENV PORT=8080
# prod deps only (fallback gdy brak locka w backend/)
COPY --from=build /app/package.json /app/pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
# compiled app
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node","dist/index.js"]

