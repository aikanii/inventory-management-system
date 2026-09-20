# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @ims/api build && pnpm --filter @ims/web build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Never run the database or the API as root.
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=app:app /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=app:app /app/bin ./bin
# PGlite writes here when no DATABASE_URL is supplied.
RUN mkdir -p /app/.ims-data && chown -R app:app /app/.ims-data
USER app
ENV IMS_DATA_DIR=/app/.ims-data PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/ims.js", "start", "--port", "3000"]
