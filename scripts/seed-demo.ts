import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uid } from "../server/src/auth";
import { getDb, type Db } from "../server/src/db";
import * as schema from "../server/src/schema";
import { buildSeedData, ensureLaunchInvites } from "../server/src/seed-content";
import { SEED_IMG, SEED_VID } from "../server/src/seedMedia";
import { getStorage } from "../server/src/storage";
import { applyMigrations } from "./migrate-lib";

/* CLI: bun run db:seed-demo — the standalone replacement for the artifact's
   seedPrototype action (plan §4.1.3: CLI-only, no HTTP action).
   Idempotent like the source: if creators already exist it prints
   "already seeded", still tops launch invites up to 10, and exits 0.
   Otherwise every distinct seed data URL is decoded, stored through the
   storage driver (env-selected: STORAGE_DRIVER/STORAGE_DIR/S3_*), recorded
   as a ready media_assets row, and the seed rows are inserted with
   `asset:<id>` references in place of data URLs — all DB inserts inside
   ONE transaction. */

function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error(`Seed media value is not a base64 data URL (starts: ${dataUrl.slice(0, 40)}…)`);
  return { mimeType: match[1], bytes: new Uint8Array(Buffer.from(match[2], "base64")) };
}

function extForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "video/mp4": return ".mp4";
    default: return ".bin";
  }
}

/** By-product for inspection: one extracted file per SEED_IMG/SEED_VID key
    under <standalone>/seed-assets/. Always written when the CLI runs. */
async function extractSeedAssets(): Promise<string> {
  const dir = join(import.meta.dir, "..", "seed-assets");
  await mkdir(dir, { recursive: true });
  for (const [key, dataUrl] of Object.entries(SEED_IMG)) {
    if (!dataUrl) continue;
    const { mimeType, bytes } = decodeDataUrl(dataUrl);
    await writeFile(join(dir, `${key}${extForMime(mimeType)}`), bytes);
  }
  for (const [key, dataUrl] of Object.entries(SEED_VID)) {
    if (!dataUrl) continue;
    const { mimeType, bytes } = decodeDataUrl(dataUrl);
    await writeFile(join(dir, `${key}${extForMime(mimeType)}`), bytes);
  }
  return dir;
}

async function printInviteCodes(db: Db, newlyCreated: string[]): Promise<void> {
  const rows = await db.select().from(schema.inviteCodes);
  console.log(`Invite codes (${rows.length} total, ${newlyCreated.length} newly created):`);
  for (const r of rows) console.log(`  ${r.code}`);
  console.log("Treat these invite codes as secrets — anyone holding one can sign up.");
}

async function main(): Promise<void> {
  const handle = await getDb();
  try {
    await applyMigrations(handle);
    const db = handle.db;

    const extractDir = await extractSeedAssets();
    console.log(`Extracted seed media files to ${extractDir}`);

    const existing = await db.select().from(schema.creators);
    if (existing.length > 0) {
      console.log("already seeded");
      const invites = await ensureLaunchInvites(db);
      if (invites.created > 0) console.log(`Topped up launch invites: created ${invites.created}.`);
      await printInviteCodes(db, invites.codes);
      return;
    }

    const now = new Date();

    /* Pass 1: collect every distinct data URL the seed references. */
    const distinct = new Set<string>();
    buildSeedData(now, (dataUrl) => { distinct.add(dataUrl); return dataUrl; });

    /* Store each distinct asset once: bytes → storage driver, row →
       media_assets (inserted in the seed transaction below). */
    const storage = getStorage();
    const refByDataUrl = new Map<string, string>();
    const mediaRows: (typeof schema.mediaAssets.$inferInsert)[] = [];
    for (const dataUrl of distinct) {
      const { mimeType, bytes } = decodeDataUrl(dataUrl);
      const id = uid("asset");
      const storageKey = `assets/${id}`;
      await storage.put(storageKey, bytes, mimeType);
      mediaRows.push({
        id,
        ownerAccountId: null,
        kind: "seed",
        storageKey,
        mimeType,
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ready: 1,
      });
      refByDataUrl.set(dataUrl, `asset:${id}`);
    }

    /* Pass 2: build the real rows with asset references. */
    const seed = buildSeedData(now, (dataUrl) => {
      const ref = refByDataUrl.get(dataUrl);
      if (!ref) throw new Error("Seed media mapper missed a data URL collected in pass 1.");
      return ref;
    });

    /* All DB inserts in ONE transaction (FK order), invites included. */
    let inviteCodes: string[] = [];
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await t.insert(schema.mediaAssets).values(mediaRows);
      await t.insert(schema.creators).values(seed.creators);
      await t.insert(schema.creatorCategories).values(seed.creatorCategories);
      await t.insert(schema.commissions).values(seed.commissions);
      await t.insert(schema.ledgerEntries).values(seed.ledgerEntries);
      await t.insert(schema.auctionLots).values(seed.auctionLots);
      await t.insert(schema.auctionItems).values(seed.auctionItems);
      await t.insert(schema.posts).values(seed.posts);
      await t.insert(schema.postCategories).values(seed.postCategories);
      const invites = await ensureLaunchInvites(t);
      inviteCodes = invites.codes;
    });

    console.log("Seeded demo content:");
    console.log(`  creators:          ${seed.creators.length}`);
    console.log(`  creatorCategories: ${seed.creatorCategories.length}`);
    console.log(`  commissions:       ${seed.commissions.length}`);
    console.log(`  ledgerEntries:     ${seed.ledgerEntries.length}`);
    console.log(`  auctionLots:       ${seed.auctionLots.length}`);
    console.log(`  auctionItems:      ${seed.auctionItems.length}`);
    console.log(`  posts:             ${seed.posts.length}`);
    console.log(`  postCategories:    ${seed.postCategories.length}`);
    console.log(`  mediaAssets:       ${mediaRows.length}`);
    await printInviteCodes(db, inviteCodes);
  } finally {
    await handle.close();
  }
}

await main();
