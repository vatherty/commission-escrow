import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/* One Drizzle pg-dialect database handle for the whole app.
   - DATABASE_URL set  → node-postgres pool (Render Postgres in production).
   - Otherwise         → PGlite (real Postgres in WASM) for local dev/tests,
                         data under PGLITE_DIR (default ./.pglite-data).
   The schema and migration SQL are identical either way. */

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  /** Run raw multi-statement SQL (migrations). */
  execSql(sqlText: string): Promise<void>;
  close(): Promise<void>;
}

let cached: Promise<DbHandle> | null = null;

export function getDb(): Promise<DbHandle> {
  if (!cached) cached = createDb();
  return cached;
}

async function createDb(): Promise<DbHandle> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new Pool({ connectionString: url });
    const db = drizzlePg(pool, { schema });
    return {
      db,
      kind: "postgres",
      execSql: async (sqlText) => { await pool.query(sqlText); },
      close: async () => { await pool.end(); },
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const dir = process.env.PGLITE_DIR ?? "./.pglite-data";
  const client = new PGlite(dir === "memory://" ? undefined : dir);
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return {
    db,
    kind: "pglite",
    execSql: async (sqlText) => { await client.exec(sqlText); },
    close: async () => { await client.close(); },
  };
}

/** Test helper: a fresh in-memory PGlite database with migrations applied. */
export async function createTestDb(): Promise<DbHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  const handle: DbHandle = {
    db,
    kind: "pglite",
    execSql: async (sqlText) => { await client.exec(sqlText); },
    close: async () => { await client.close(); },
  };
  const { applyMigrations } = await import("../../scripts/migrate-lib");
  await applyMigrations(handle);
  return handle;
}
