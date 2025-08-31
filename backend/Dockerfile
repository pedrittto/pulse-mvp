# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
# pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9 --activate
# deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
# sources
COPY . .
# build TS -> dist/
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
ENV NODE_ENV=production
ENV PORT=8080
# prod deps only (fallback gdy brak locka w backend/)
COPY --from=build /app/package.json /app/pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
# compiled app
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node","dist/index.js"]
