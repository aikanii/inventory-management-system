/**
 * Data access layer.
 *
 * Two drivers implement one interface:
 *   - PGlite  : PostgreSQL compiled to WASM, embedded in the process. This is what
 *               makes the app a single executable with no external database.
 *   - pg      : node-postgres, for a real PostgreSQL server in production.
 *
 * The SQL is identical for both because both are PostgreSQL. Nothing above this
 * file knows which driver is in use.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Result<T = Record<string, unknown>> {
  rows: T[];
}

export interface Database {
  readonly driver: 'pglite' | 'pg';
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Result<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- PGlite

class PGliteDb implements Database {
  readonly driver = 'pglite' as const;
  private constructor(
    private db: PGlite,
    private inTx: boolean,
  ) {}

  static async open(dataDir?: string): Promise<PGliteDb> {
    const db = dataDir ? await PGlite.create({ dataDir }) : await PGlite.create();
    if (dataDir) mkdirSync(dirname(dataDir), { recursive: true });
    return new PGliteDb(db, false);
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<Result<T>> {
    const res = await this.db.query<T>(sql, params as unknown[]);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.db.transaction(async (tx) => {
      const wrapped = new PGliteDb(tx as unknown as PGlite, true);
      return fn(wrapped);
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

// ---------------------------------------------------------------- node-postgres

class PgDb implements Database {
  readonly driver = 'pg' as const;
  private constructor(
    private pool: pg.Pool,
    private client?: pg.PoolClient,
  ) {}

  static async open(connectionString: string): Promise<PgDb> {
    const pool = new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX ?? 5) });
    const db = new PgDb(pool);
    await db.query('select 1 as ok');
    return db;
  }

  private get runner(): pg.Pool | pg.PoolClient {
    return this.client ?? this.pool;
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<Result<T>> {
    const res = await this.runner.query(sql, params as unknown[]);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.runner.query(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (this.client) return fn(this);
    const client = await this.pool.connect();
    const tx = new PgDb(this.pool, client);
    try {
      await client.query('BEGIN');
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------- factory

export interface DatabaseOptions {
  /** postgres:// URL. When omitted the app runs on embedded PGlite. */
  url?: string;
  /** Filesystem directory for the embedded database. Ignored when url is set. */
  dataDir?: string;
}

export async function openDatabase(opts: DatabaseOptions = {}): Promise<Database> {
  if (opts.url) return PgDb.open(opts.url);
  return PGliteDb.open(opts.dataDir);
}
