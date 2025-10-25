# --- builder ---
    FROM node:20-alpine AS builder
    WORKDIR /app
    # prościej: pnpm globalnie, bez corepack
    RUN npm i -g pnpm@9.15.9
    COPY package.json tsconfig.json ./
    COPY src ./src
    # brak lockfile → instalujemy bez --frozen-lockfile
    RUN pnpm install --no-frozen-lockfile
    RUN pnpm run build
    
    # --- runtime ---
    FROM node:20-alpine AS runtime
    WORKDIR /app
    RUN npm i -g pnpm@9.15.9
    COPY package.json ./
    RUN pnpm install --prod --no-frozen-lockfile
    COPY --from=builder /app/dist ./dist
    EXPOSE 8080
    CMD ["node","dist/index.js"]