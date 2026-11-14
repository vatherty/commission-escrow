import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbHandle } from "../server/src/db";

/* Minimal, explicit migration runner: applies server/migrations-pg/*.sql
   in filename order, each exactly once, tracked in a _migrations table.
   Safe to re-run (idempotent runner behaviour per plan Step 2). */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "server", "migrations-pg");

export async function applyMigrations(handle: DbHandle): Promise<string[]> {
  await handle.execSql(`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );`);
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const check = await queryOne(handle, `SELECT name FROM _migrations WHERE name = '${file}'`);
    if (check) continue;
    const sqlText = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await handle.execSql(sqlText);
    await handle.execSql(`INSERT INTO _migrations (name) VALUES ('${file}');`);
    applied.push(file);
  }
  return applied;
}

async function queryOne(handle: DbHandle, sqlText: string): Promise<unknown> {
  // Works on both backends through the raw drivers behind execSql's siblings:
  // node-postgres pool query / PGlite query. We go through the drizzle db's
  // session-agnostic sql execution instead.
  const { sql } = await import("drizzle-orm");
  const rows = await handle.db.execute(sql.raw(sqlText));
  const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  return Array.isArray(list) ? list[0] : undefined;
}

/** Current applied migration names, for /readyz. */
export async function appliedMigrations(handle: DbHandle): Promise<string[]> {
  try {
    const { sql } = await import("drizzle-orm");
    const rows = await handle.db.execute(sql.raw(`SELECT name FROM _migrations ORDER BY name`));
    const list = (rows as unknown as { rows?: { name: string }[] }).rows ?? (rows as unknown as { name: string }[]);
    return (list as { name: string }[]).map(r => r.name);
  } catch {
    return [];
  }
}
