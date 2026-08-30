# ATLAS — imagen para Cloud Run (Fase 2).
# Etapa 1: instala dependencias y empaqueta con esbuild (bundle CJS único: sin node_modules en runtime).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Etapa 2: runtime mínimo. Cloud Run inyecta PORT; los secretos llegan por Secret Manager (F11).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.cjs"]
