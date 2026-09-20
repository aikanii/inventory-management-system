import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';

export interface Migration {
  id: string;
  sql: string;
}

/** Migrations are read from disk next to this module, so src (tsx) and dist (node) both work. */
export function loadMigrations(): Migration[] {
  const dir = fileURLToPath(new URL('./migrations', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: readFileSync(`${dir}/${f}`, 'utf8') }));
}

/**
 * Forward-only migrator. Each file runs inside its own transaction and is
 * recorded in `migration`, so a re-run is a no-op and a failure leaves the
 * database exactly as it was.
 */
export async function migrate(db: Database): Promise<{ applied: string[]; skipped: number }> {
  await db.exec(`CREATE TABLE IF NOT EXISTS migration (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const done = new Set(
    (await db.query<{ id: string }>('SELECT id FROM migration')).rows.map((r) => r.id),
  );

  const applied: string[] = [];
  for (const m of loadMigrations()) {
    if (done.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO migration (id) VALUES ($1)', [m.id]);
    });
    applied.push(m.id);
  }
  return { applied, skipped: done.size };
}

export async function schemaRevision(db: Database): Promise<string | null> {
  const rows = await db.query<{ id: string }>('SELECT id FROM migration ORDER BY id DESC LIMIT 1');
  return rows.rows[0]?.id ?? null;
}
