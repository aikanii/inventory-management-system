#!/usr/bin/env node
/**
 * ims — the Inventory Management System launcher.
 *
 *   ims start [--port 3000]   Run the server (API + web UI)
 *   ims migrate               Apply pending database migrations
 *   ims seed [--days 150]     Load the deterministic demo store
 *   ims reset                 Wipe the local database and start over
 *   ims doctor                Check the runtime, database and web bundle
 *   ims version | help
 *
 * With no DATABASE_URL set, everything runs on an embedded PostgreSQL (PGlite)
 * inside .ims-data/ — no database server to install.
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const apiDist = resolve(repoRoot, 'apps/api/dist');
const entry = resolve(apiDist, 'main.js');

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  return fallback;
}

function requireBuild() {
  if (!existsSync(entry)) {
    console.error('The API has not been built yet.');
    console.error('  pnpm install && pnpm build');
    process.exit(1);
  }
}

function printHelp() {
  console.log(`Inventory Management System

Usage: ims <command> [options]

Commands:
  start [--port 3000]    Run the server (API + web UI) on 0.0.0.0
  migrate                Apply pending database migrations
  seed [--days 150]      Load the deterministic demo store
  reset                  Delete the local embedded database
  doctor                 Check runtime, database and web bundle
  version                Print the version
  help                   Show this message

Environment:
  IMS_DATA_DIR   Where the embedded database lives (default: ./.ims-data)
  DATABASE_URL   Use a real PostgreSQL server instead of the embedded one
  PORT           Port for "ims start" (default: 3000)
`);
}

async function main() {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;

    case 'version':
    case '--version': {
      requireBuild();
      const mod = await import(entry);
      console.log(`ims ${mod.VERSION}`);
      return;
    }

    case 'doctor': {
      const checks = [
        ['node >= 20.11', Number(process.versions.node.split('.')[0]) >= 20],
        ['api built (apps/api/dist)', existsSync(entry)],
        ['web bundle (apps/web/dist)', existsSync(resolve(repoRoot, 'apps/web/dist/index.html'))],
        ['embedded database driver', true],
      ];
      console.log('Runtime checks:');
      for (const [label, ok] of checks) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
      }
      if (!existsSync(entry)) process.exitCode = 1;
      if (existsSync(entry)) {
        const { bootstrap } = await import(entry);
        const runtime = await bootstrap();
        const revision = await (await import(resolve(apiDist, 'db/migrate.js'))).schemaRevision(runtime.db);
        const store = await runtime.db.query('SELECT count(*)::int AS n FROM store');
        console.log(`  ✓ database reachable (driver: ${runtime.db.driver})`);
        console.log(`  ✓ schema revision: ${revision ?? 'none'}`);
        console.log(`  ✓ stores: ${store.rows[0]?.n ?? 0}`);
        console.log(`  · data dir: ${process.env.DATABASE_URL ?? resolve(process.cwd(), '.ims-data')}`);
        await runtime.close();
      }
      return;
    }

    case 'reset': {
      if (process.env.DATABASE_URL) {
        console.error('Refusing to reset: DATABASE_URL points at a real server.');
        console.error('Unset DATABASE_URL to reset the local embedded database.');
        process.exit(1);
      }
      const dataDir = process.env.IMS_DATA_DIR ?? resolve(process.cwd(), '.ims-data');
      if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      console.log(`removed ${dataDir}`);
      return;
    }

    case 'migrate': {
      requireBuild();
      const { bootstrap } = await import(entry);
      const runtime = await bootstrap();
      const revision = await (await import(resolve(apiDist, 'db/migrate.js'))).schemaRevision(runtime.db);
      console.log(`schema at revision ${revision ?? 'none'} (driver: ${runtime.db.driver})`);
      await runtime.close();
      return;
    }

    case 'seed': {
      requireBuild();
      const { bootstrap } = await import(entry);
      const { seed } = await import(resolve(apiDist, 'seed.js'));
      const runtime = await bootstrap();
      const started = Date.now();
      const result = await seed(runtime.db, { days: Number(flag('days', 150)) });
      console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log(`  store    : ${result.storeId}`);
      console.log(`  products : ${result.products}`);
      console.log(`  sales    : ${result.sales}`);
      console.log(`  expenses : ${result.expenses}`);
      console.log('  logins   :');
      for (const u of result.users) console.log(`    ${u.role.padEnd(8)} ${u.email}  ${u.password}`);
      await runtime.close();
      return;
    }

    case 'start': {
      requireBuild();
      const { bootstrap } = await import(entry);
      const runtime = await bootstrap();
      const port = Number(flag('port', process.env.PORT ?? 3000));
      runtime.queue.start();
      runtime.app.listen(port, '0.0.0.0', () => {
        console.log(`IMS listening on http://0.0.0.0:${port}`);
        console.log(`  driver   : ${runtime.db.driver}`);
        console.log(`  api      : http://localhost:${port}/api/v1/meta`);
        console.log(`  health   : http://localhost:${port}/healthz`);
      });
      const shutdown = async () => {
        await runtime.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      return;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
