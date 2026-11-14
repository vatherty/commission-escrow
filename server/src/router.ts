import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { eq } from "drizzle-orm";
import { Actions, accountPayload, mediaUrlOf, refOf } from "./actions";
import * as schema from "./schema";
import type { Db, DbHandle } from "./db";
import type { StorageDriver } from "./storage";
import type { ActionDef, AppCtx } from "./registry";
import {
  ANON_CSRF_COOKIE,
  SESSION_COOKIE,
  anonCsrfCookieHeader,
  anonCsrfValid,
  clearSessionCookieHeader,
  csrfValid,
  deriveCsrf,
  isAdminAccount,
  newAnonCsrf,
  parseCookies,
  resolveSession,
  roleOf,
  sessionCookieHeader,
  tokenHash,
  uid,
  type AccountRow,
} from "./auth";
import { appliedMigrations } from "../../scripts/migrate-lib";

/* HTTP shell for the standalone service (CONTRACT.md). One origin serves
   the built client and the API. Security order on every mutation:
   session resolution → Origin check → CSRF check → Zod validation →
   handler inside a transaction. A failed CSRF/origin check means the
   handler never runs. */

export interface RouterDeps {
  handle: DbHandle;
  storage: StorageDriver;
  clientDir: string;
}

type CtxBase = Omit<AppCtx, "db">;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function bytesBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function errJson(status: number, code: string, message: string): Response {
  return json({ ok: false, error: { code, message } }, status);
}
const CSRF_MESSAGE = "Your session check failed — refresh the page and try again.";
const LOGIN_MESSAGE = "Please log in first — your session may have expired.";

const UPLOAD_KINDS = new Set(["profile", "banner", "background", "showcase", "portfolio", "post_image", "post_video", "auction", "sketch", "vault_preview", "vault_original"]);
function uploadCap(kind: string): number {
  if (kind === "post_video") return 2_100_000;
  if (kind === "vault_original") return 2_200_000;
  return 700_000;
}
function sniffKind(bytes: Uint8Array): "jpeg" | "png" | "gif" | "webp" | "mp4" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "mp4";
  return null;
}

export function createHandler(deps: RouterDeps): (req: Request) => Promise<Response> {
  const db = deps.handle.db;

  async function resolveCtx(req: Request): Promise<{ base: CtxBase; account: AccountRow | null }> {
    const cookies = parseCookies(req.headers.get("cookie"));
    const raw = cookies[SESSION_COOKIE] ?? "";
    let account: AccountRow | null = null;
    let sessionHash: string | null = null;
    if (raw) {
      const resolved = await resolveSession(db, raw);
      if (resolved) {
        account = resolved.account;
        sessionHash = resolved.session.token;
      }
    }
    const base: CtxBase = {
      account,
      sessionHash,
      setSessionCookie: null,
      clearSessionCookie: false,
      csrfToken: null,
      requestId: randomBytes(6).toString("hex"),
      ip: null,
    };
    return { base, account };
  }

  function originOk(req: Request, url: URL): boolean {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    const appOrigin = process.env.APP_ORIGIN;
    if (appOrigin && origin === appOrigin) return true;
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }

  function csrfOk(req: Request, base: CtxBase): boolean {
    const presented = req.headers.get("x-csrf-token") ?? "";
    if (base.sessionHash) return csrfValid(base.sessionHash, presented);
    const cookies = parseCookies(req.headers.get("cookie"));
    return anonCsrfValid(cookies[ANON_CSRF_COOKIE] ?? "", presented);
  }

  async function handleRpc(req: Request, url: URL, name: string, base: CtxBase): Promise<Response> {
    const def = (Actions as unknown as Record<string, ActionDef<unknown, unknown>>)[name];
    if (!def) return errJson(404, "not_found", "Unknown action.");
    if (!originOk(req, url)) return errJson(403, "csrf", CSRF_MESSAGE);
    if (!csrfOk(req, base)) return errJson(403, "csrf", CSRF_MESSAGE);
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = def.request.safeParse(body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return errJson(400, "validation", issue ? `Invalid ${issue.path.join(".") || "request"}: ${issue.message}` : "Invalid request.");
    }
    let cookieHeader: string | null = null;
    let result: unknown;
    const runWith = async (ctxDb: Db): Promise<unknown> => {
      const ctx: AppCtx = { ...base, db: ctxDb };
      const out = await def.handler(ctx, parsed.data);
      if (ctx.setSessionCookie) cookieHeader = sessionCookieHeader(ctx.setSessionCookie);
      if (ctx.clearSessionCookie) cookieHeader = clearSessionCookieHeader();
      return out;
    };
    try {
      /* Every handler runs inside a transaction — EXCEPT logIn. The
         login throttle records a failed attempt and then throws; in the
         Space (per-statement autocommit) that row survived the error,
         which is what makes the throttle accumulate. Wrapping logIn in
         a transaction would roll the attempt back and silently disable
         the throttle. Its writes are single-statement and
         self-consistent, so it runs unwrapped. */
      result = name === "logIn"
        ? await runWith(db)
        : await db.transaction(async (tx) => runWith(tx as unknown as Db));
    } catch (e) {
      return errJson(400, "error", e instanceof Error ? e.message : "Something went wrong — please try again.");
    }
    const checked = def.response.safeParse(result);
    if (!checked.success) {
      console.error(`[rpc] ${name} response failed schema validation`, checked.error.issues[0]);
      return errJson(500, "error", "Something went wrong — please try again.");
    }
    return json(checked.data, 200, cookieHeader ? { "Set-Cookie": cookieHeader } : {});
  }

  async function handleSessionRoute(req: Request, base: CtxBase): Promise<Response> {
    if (base.account && base.sessionHash) {
      const ctx: AppCtx = { ...base, db };
      return json({ account: await accountPayload(ctx, base.account), csrfToken: deriveCsrf(base.sessionHash) });
    }
    const jar = parseCookies(req.headers.get("cookie"));
    let anon = jar[ANON_CSRF_COOKIE] ?? "";
    const headers: Record<string, string> = {};
    if (!anon || !anonCsrfValid(anon, anon)) {
      anon = newAnonCsrf();
      headers["Set-Cookie"] = anonCsrfCookieHeader(anon);
    }
    return json({ account: null, csrfToken: anon }, 200, headers);
  }

  /* ---- Uploads ---- */

  async function uploadInit(req: Request, url: URL, base: CtxBase): Promise<Response> {
    if (!base.account) return errJson(401, "auth", LOGIN_MESSAGE);
    if (!originOk(req, url) || !csrfOk(req, base)) return errJson(403, "csrf", CSRF_MESSAGE);
    let body: { kind?: unknown; mimeType?: unknown; byteSize?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { body = {}; }
    const kind = typeof body.kind === "string" ? body.kind : "";
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
    const byteSize = typeof body.byteSize === "number" ? body.byteSize : 0;
    if (!UPLOAD_KINDS.has(kind)) return errJson(400, "error", "Unknown upload kind.");
    if (!Number.isInteger(byteSize) || byteSize <= 0) return errJson(400, "error", "That file looks empty.");
    if (byteSize > uploadCap(kind)) return errJson(400, "error", kind === "post_video" || kind === "vault_original" ? "That file is too big — keep it under about 2 MB." : "That image is too big — keep it under about 700 KB.");
    if (kind === "post_video" && mimeType !== "video/mp4") return errJson(400, "error", "Post videos must be MP4 files.");
    if (kind !== "post_video" && kind !== "vault_original" && !mimeType.startsWith("image/")) return errJson(400, "error", "That file isn't an image.");
    if (kind === "vault_original" && !mimeType.startsWith("image/") && !mimeType.startsWith("video/")) return errJson(400, "error", "Vault originals must be image or video files.");
    const id = uid("asset");
    await db.insert(schema.mediaAssets).values({ id, ownerAccountId: base.account.id, kind, storageKey: `assets/${id}`, mimeType, byteSize, ready: 0 });
    return json({ assetId: id, uploadPath: `/api/uploads/${id}/blob` });
  }

  async function uploadBlob(req: Request, url: URL, base: CtxBase, assetId: string): Promise<Response> {
    if (!base.account) return errJson(401, "auth", LOGIN_MESSAGE);
    if (!originOk(req, url) || !csrfOk(req, base)) return errJson(403, "csrf", CSRF_MESSAGE);
    const rows = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
    const a = rows[0];
    if (!a || a.ownerAccountId !== base.account.id) return errJson(404, "not_found", "That upload couldn't be found.");
    if (a.ready === 1) return errJson(400, "error", "That upload is already complete.");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return errJson(400, "error", "That file looks empty.");
    if (bytes.length > uploadCap(a.kind)) return errJson(400, "error", "That file is too big.");
    await deps.storage.put(a.storageKey, bytes, a.mimeType);
    await db.update(schema.mediaAssets).set({ byteSize: bytes.length }).where(eq(schema.mediaAssets.id, a.id));
    return json({ ok: true });
  }

  async function uploadComplete(req: Request, url: URL, base: CtxBase): Promise<Response> {
    if (!base.account) return errJson(401, "auth", LOGIN_MESSAGE);
    if (!originOk(req, url) || !csrfOk(req, base)) return errJson(403, "csrf", CSRF_MESSAGE);
    let body: { assetId?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { body = {}; }
    const assetId = typeof body.assetId === "string" ? body.assetId : "";
    const rows = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
    const a = rows[0];
    if (!a || a.ownerAccountId !== base.account.id) return errJson(404, "not_found", "That upload couldn't be found.");
    if (a.ready === 1) return json({ ok: true, ref: `asset:${a.id}` });
    const bytes = await deps.storage.get(a.storageKey);
    if (!bytes) return errJson(400, "error", "That upload's file is missing — try uploading it again.");
    const sniffed = sniffKind(bytes);
    const isVideoKind = a.kind === "post_video";
    if (isVideoKind && sniffed !== "mp4") return errJson(400, "error", "That file doesn't look like an MP4 video.");
    if (!isVideoKind && a.kind !== "vault_original" && !sniffed) return errJson(400, "error", "That file doesn't look like a JPEG, PNG, GIF or WebP image.");
    if (a.kind === "vault_original" && !sniffed) return errJson(400, "error", "That file doesn't look like an image or MP4 video.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await db.update(schema.mediaAssets).set({ sha256, ready: 1 }).where(eq(schema.mediaAssets.id, a.id));
    return json({ ok: true, ref: `asset:${a.id}` });
  }

  /* ---- Media serving ---- */

  async function serveMedia(base: CtxBase, assetId: string): Promise<Response> {
    const rows = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
    const a = rows[0];
    if (!a || a.ready !== 1 || a.deletedAt) return errJson(404, "not_found", "Not found.");
    if (a.kind === "vault_original") return errJson(404, "not_found", "Not found.");
    const ref = `asset:${a.id}`;
    const notFound = () => errJson(404, "not_found", "Not found.");

    const acctRows = await db.select().from(schema.accounts);
    const bannedCreatorIds = new Set(acctRows.filter(x => x.isBanned === 1).map(x => x.creatorId).filter((x): x is string => !!x));
    const ownedCreatorIds = new Set(acctRows.map(x => x.creatorId).filter((x): x is string => !!x));
    const caller = base.account;
    const callerIsStaff = caller ? roleOf(caller) !== "member" : false;

    let referenced = false;

    const creatorRows = await db.select().from(schema.creators);
    for (const c of creatorRows) {
      const portfolio = (() => { try { return JSON.parse(c.portfolioImagesJson ?? "{}") as Record<string, string>; } catch { return {}; } })();
      if (c.pfpUrl === ref || c.bannerUrl === ref || c.bgImageUrl === ref || c.showcaseUrl === ref || Object.values(portfolio).includes(ref)) {
        referenced = true;
        if (c.quarantined === 1 || bannedCreatorIds.has(c.id)) return notFound();
      }
    }
    const postRows = await db.select().from(schema.posts);
    for (const p of postRows) {
      if (p.imageUrl === ref || p.videoUrl === ref) {
        referenced = true;
        if (p.quarantined === 1) return notFound();
        const owner = creatorRows.find(c => c.id === p.creatorId);
        if (owner && (owner.quarantined === 1 || bannedCreatorIds.has(owner.id))) return notFound();
      }
    }
    const itemRows = await db.select().from(schema.auctionItems);
    for (const it of itemRows) {
      if (it.mediaUrl === ref) {
        referenced = true;
        if (it.quarantined === 1) return notFound();
      }
    }
    const commRows = await db.select().from(schema.commissions);
    for (const cm of commRows) {
      if (cm.sketchImageUrl === ref || cm.vaultPreviewUrl === ref) {
        referenced = true;
        /* Job media follows the job's visibility (the getState split):
           public for demo jobs, parties/staff for real-account jobs. */
        const hasRealParty = !!cm.buyerAccountId || ownedCreatorIds.has(cm.creatorId);
        if (hasRealParty) {
          if (!caller) return notFound();
          if (!callerIsStaff && cm.buyerAccountId !== caller.id && caller.creatorId !== cm.creatorId) return notFound();
        }
      }
    }

    if (!referenced) {
      /* Unattached upload: only its owner may view it. */
      if (!caller || a.ownerAccountId !== caller.id) return notFound();
    }
    const bytes = await deps.storage.get(a.storageKey);
    if (!bytes) return notFound();
    return new Response(bytesBody(bytes), {
      status: 200,
      headers: { "Content-Type": a.mimeType, "Cache-Control": "private, no-cache", "Content-Length": String(bytes.length) },
    });
  }

  /* ---- Vault download ---- */

  async function vaultFile(base: CtxBase, commissionId: string): Promise<Response> {
    if (!base.account) return errJson(401, "auth", LOGIN_MESSAGE);
    const account = base.account;
    let prepared: { asset: typeof schema.mediaAssets.$inferSelect; count: number; fileName: string } | null = null;
    try {
      prepared = await db.transaction(async (tx) => {
        const rows = await tx.select().from(schema.commissions).where(eq(schema.commissions.id, commissionId));
        const c = rows[0];
        if (!c) throw new Error("That job couldn't be found.");
        if (c.status !== "unlocked" || !c.vaultFileUrl) throw new Error("The original unlocks only after the artist confirms the balance was paid. Until then, the watermarked preview is all anyone sees.");
        if (c.buyerAccountId) {
          if (account.id !== c.buyerAccountId) throw new Error("Only the buyer of record can download the unlocked original.");
        } else if (roleOf(account) === "member") {
          throw new Error("Only the buyer of record can download the unlocked original.");
        }
        const ref = refOf(c.vaultFileUrl);
        if (!ref.startsWith("asset:")) throw new Error("That job's original isn't available as a file download.");
        const aRows = await tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, ref.slice("asset:".length)));
        const asset = aRows[0];
        if (!asset || asset.kind !== "vault_original" || asset.ready !== 1) throw new Error("That job's original isn't available as a file download.");
        const n = (c.downloadCount ?? 0) + 1;
        await tx.update(schema.commissions).set({ downloadCount: n, updatedAt: new Date() }).where(eq(schema.commissions.id, c.id));
        await tx.insert(schema.ledgerEntries).values({ commissionId: c.id, label: `Original downloaded by buyer (download #${n}, logged)`, fromState: "Unlocked", toState: "Unlocked", amount: 0, note: "The vault serves the original only to the buyer of record, only after unlock — and every serve is written into the job record." });
        return { asset, count: n, fileName: c.vaultFileName || "final-artwork" };
      });
    } catch (e) {
      return errJson(400, "error", e instanceof Error ? e.message : "Something went wrong — please try again.");
    }
    if (!prepared) return errJson(404, "not_found", "Not found.");
    const bytes = await deps.storage.get(prepared.asset.storageKey);
    if (!bytes) return errJson(404, "not_found", "Not found.");
    const safeName = prepared.fileName.replace(/[\r\n"]/g, "_");
    return new Response(bytesBody(bytes), {
      status: 200,
      headers: {
        "Content-Type": prepared.asset.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(prepared.fileName)}`,
        "X-Download-Count": String(prepared.count),
        "Cache-Control": "private, no-store",
      },
    });
  }

  /* ---- Static client ---- */

  async function serveStatic(url: URL): Promise<Response> {
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    const filePath = join(deps.clientDir, rel === "" ? "index.html" : rel);
    if (rel && existsSync(filePath)) {
      return new Response(Bun.file(filePath));
    }
    const indexPath = join(deps.clientDir, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return errJson(404, "not_found", "Not found.");
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/healthz") return json({ ok: true });
      if (path === "/readyz") {
        const applied = await appliedMigrations(deps.handle);
        return json({ ok: true, migrations: applied }, applied.length > 0 ? 200 : 503);
      }
      const { base } = await resolveCtx(req);

      if (path === "/api/session" && req.method === "GET") return handleSessionRoute(req, base);

      if (path.startsWith("/api/rpc/")) {
        if (req.method !== "POST") return errJson(404, "not_found", "Unknown action.");
        return handleRpc(req, url, decodeURIComponent(path.slice("/api/rpc/".length)), base);
      }
      if (path === "/api/uploads/init" && req.method === "POST") return uploadInit(req, url, base);
      if (path === "/api/uploads/complete" && req.method === "POST") return uploadComplete(req, url, base);
      const blobMatch = /^\/api\/uploads\/([^/]+)\/blob$/.exec(path);
      if (blobMatch && req.method === "PUT") return uploadBlob(req, url, base, decodeURIComponent(blobMatch[1] ?? ""));
      const mediaMatch = /^\/media\/([^/]+)$/.exec(path);
      if (mediaMatch && req.method === "GET") return serveMedia(base, decodeURIComponent(mediaMatch[1] ?? ""));
      const vaultMatch = /^\/api\/jobs\/([^/]+)\/vault-file$/.exec(path);
      if (vaultMatch && req.method === "GET") return vaultFile(base, decodeURIComponent(vaultMatch[1] ?? ""));

      if (path.startsWith("/api/") || path.startsWith("/media/")) return errJson(404, "not_found", "Not found.");
      if (req.method !== "GET") return errJson(404, "not_found", "Not found.");
      return serveStatic(url);
    } catch (e) {
      console.error("[http] unhandled error", e);
      return errJson(500, "error", "Something went wrong — please try again.");
    }
  };
}

/* Re-exported for tests and the session route's account payload typing. */
export { isAdminAccount, tokenHash, mediaUrlOf };
