import { join } from "node:path";
import { getDb } from "./db";
import { getStorage } from "./storage";
import { createHandler } from "./router";
import { applyMigrations } from "../../scripts/migrate-lib";

/* Standalone service entry: one Bun process serving the built client and
   the API from one origin. Migrations run on boot (idempotent) unless
   RUN_MIGRATIONS=0 — on Render the same command path is used by the
   one-off migration step in DEPLOY.md. */

const handle = await getDb();
if (process.env.RUN_MIGRATIONS !== "0") {
  const applied = await applyMigrations(handle);
  if (applied.length > 0) console.log(`[boot] applied migrations: ${applied.join(", ")}`);
}

const clientDir = process.env.CLIENT_DIR ?? join(import.meta.dir, "..", "..", "client", "dist");
const port = Number(process.env.PORT || 3000);
const fetch = createHandler({ handle, storage: getStorage(), clientDir });

const server = Bun.serve({ port, fetch });
console.log(`Commission Escrow standalone listening on http://localhost:${server.port} (db: ${handle.kind}, storage: ${process.env.STORAGE_DRIVER ?? "local"})`);
