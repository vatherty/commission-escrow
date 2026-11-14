import { getDb } from "../server/src/db";
import { applyMigrations } from "./migrate-lib";

/* CLI: bun run db:migrate — applies pending Postgres migrations to the
   configured database (DATABASE_URL, or local PGlite when unset). */

const handle = await getDb();
const applied = await applyMigrations(handle);
console.log(applied.length > 0 ? `Applied migrations: ${applied.join(", ")}` : "Database already up to date.");
await handle.close();
