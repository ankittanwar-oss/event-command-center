# One image for both Railway services. The web service runs the default CMD; the sync-worker service overrides
# the start command (see railway/worker.json).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
RUN npm test && npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
