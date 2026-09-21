/**
 * Application entry point.
 *
 * One process serves the API and the built web bundle. With no DATABASE_URL set
 * it runs on an embedded PostgreSQL (PGlite) in a local data directory, so the
 * whole system is a single executable with nothing to install.
 */
import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type Database } from './db/database.js';
import { migrate, schemaRevision } from './db/migrate.js';
import { ensureJwtKeys, type JwtKeys } from './shared/security.js';
import { createQueue, buildHandlers, type Queue } from './worker/index.js';
import {
  authenticate, asyncHandler, errorHandler, notFoundHandler, ok, requestIdMiddleware, resolveStore,
  type AppContext, type AuthedRequest,
} from './shared/http.js';
import { authRouter } from './modules/auth.js';
import { catalogRouter } from './modules/catalog.js';
import { inventoryRouter } from './modules/inventory.js';
import { salesRouter } from './modules/sales.js';
import { purchasingRouter } from './modules/purchasing.js';
import { reportingRouter } from './modules/reporting.js';
import { aiRouter } from './modules/ai.js';
import { forbidden } from './shared/errors.js';

export const VERSION = '0.1.0';

export interface Runtime {
  db: Database;
  keys: JwtKeys;
  queue: Queue;
  app: Express;
  close: () => Promise<void>;
}

export function loadEnvFile(): void {
  const candidate = resolve(process.cwd(), '.env');
  if (existsSync(candidate) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(candidate);
  }
}

export function defaultDataDir(): string {
  return process.env.IMS_DATA_DIR ?? resolve(process.cwd(), '.ims-data');
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(requestIdMiddleware);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // Health probes live at the host root so a load balancer needs no version prefix.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
  });
  app.get('/readyz', async (_req, res) => {
    try {
      await ctx.db.query('SELECT 1 AS ok');
      const revision = await schemaRevision(ctx.db);
      res.json({ status: 'ready', driver: ctx.db.driver, schema_revision: revision });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  const api = express.Router();
  api.use((req, res, next) => {
    req.ctx = ctx;
    next();
  });
  api.get('/meta', (_req, res) => {
    res.json({ data: { version: VERSION, driver: ctx.db.driver, ai_provider: process.env.AI_PROVIDER ?? 'local' } });
  });
  api.use('/auth', authRouter(ctx));
  api.use('/', catalogRouter(ctx));
  api.use('/inventory', inventoryRouter(ctx));
  api.use('/', salesRouter(ctx));
  api.use('/', purchasingRouter(ctx));
  api.use('/', reportingRouter(ctx));
  api.use('/ai', aiRouter(ctx));
  // Audit trail. `authenticate` has to be explicit here: this route is mounted
  // directly on the API router, so it does not inherit the middleware that the
  // feature routers install on themselves.
  api.get('/audit-logs', authenticate(ctx), resolveStore(ctx), asyncHandler<AuthedRequest>(async (req, res) => {
    if (req.auth.role !== 'OWNER') throw forbidden('Owner role required for the audit log.');
    const rows = await ctx.db.query(
      `SELECT a.*, u.email AS actor_email FROM audit_log a
         LEFT JOIN app_user u ON u.id = a.actor_id
        WHERE ($1::uuid IS NULL OR a.store_id = $1)
        ORDER BY a.id DESC LIMIT 200`,
      [req.auth.storeId],
    );
    ok(res, rows.rows);
  }));

  app.use('/api/v1', api);
  app.use('/api', api);

  // Serve the built SPA. In development Vite serves it and proxies /api here.
  const webDist = process.env.IMS_WEB_DIST
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, {
      index: 'index.html',
      setHeaders(res, filePath) {
        // Vite hashes asset filenames, so those are immutable. index.html must
        // never be cached: a browser holding yesterday's copy keeps requesting a
        // bundle that no longer exists on disk and silently runs stale code.
        if (filePath.endsWith(`${sep}index.html`)) res.setHeader('Cache-Control', 'no-cache');
        else if (filePath.includes(`${sep}assets${sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }));
    // SPA fallback. Express 5 (path-to-regexp v8) no longer accepts a bare '*',
    // so deep links are served by a guard middleware instead of a wildcard route.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/healthz')
        || req.path.startsWith('/readyz')) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(resolve(webDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send(
        'Inventory Management System API is running.\n'
        + 'The web bundle has not been built yet — run: pnpm --filter @ims/web build\n'
        + `API docs: /api/v1/meta · health: /healthz\n`,
      );
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export async function bootstrap(): Promise<Runtime> {
  loadEnvFile();
  const url = process.env.DATABASE_URL;
  const db = await openDatabase(url ? { url } : { dataDir: defaultDataDir() });
  const { applied } = await migrate(db);
  if (applied.length > 0) console.log(`applied migration(s): ${applied.join(', ')}`);

  const keys = await ensureJwtKeys(db);
  const queue = createQueue(db, buildHandlers(db));
  const ctx: AppContext = { db, keys, enqueue: (kind, payload) => queue.enqueue(kind, payload) };
  const app = createApp(ctx);

  return {
    db,
    keys,
    queue,
    app,
    async close() {
      queue.stop();
      await db.close();
    },
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  const runtime = await bootstrap();
  const port = Number(process.env.PORT ?? 3000);
  runtime.queue.start();
  const server = runtime.app.listen(port, '0.0.0.0', () => {
    console.log(`IMS ${VERSION} listening on http://0.0.0.0:${port} (db driver: ${runtime.db.driver})`);
  });
  const shutdown = async () => {
    server.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
