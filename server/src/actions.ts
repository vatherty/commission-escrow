import { z } from "zod";
import { and, asc, countDistinct, desc, eq, inArray, or, sql } from "drizzle-orm";
import * as schema from "./schema";
import { defineAction, type AppCtx } from "./registry";
import {
  createSession,
  deleteAccountSessions,
  hashPassword as authHashPassword,
  isAdminAccount,
  newInviteCode,
  ownerEmail,
  roleOf,
  uid,
  verifyPassword as authVerifyPassword,
  type AccountRow,
} from "./auth";

/* Standalone port of the Commission Escrow action monolith. Transport
   differences from the artifact version (see CONTRACT.md): identity comes
   from the session cookie via ctx.account (no token arguments), password /
   token crypto is direct server-side code in auth.ts with identical
   formats, every handler runs inside a Postgres transaction provided by
   the router, media fields hold asset references, and seeding lives in
   scripts/seed-demo.ts (no seedPrototype action). */

function parseJson<T>(s: string, fallback: T): T { try { return JSON.parse(s) as T; } catch { return fallback; } }

/* ---- Category taxonomy: the FIXED, server-side single source of truth ----
   Every category a creator can pick, the editor can submit, and search can
   filter by comes from this list. Unknown values are rejected, never stored.
   Two groups: what they MAKE (medium) and what it's ABOUT (subject/style). */
export const CATEGORY_TAXONOMY: { name: string; group: "medium" | "subject" }[] = [
  { name: "Digital Illustration", group: "medium" },
  { name: "Traditional Art", group: "medium" },
  { name: "3D Art & Renders", group: "medium" },
  { name: "Pixel Art", group: "medium" },
  { name: "Animation & GIFs", group: "medium" },
  { name: "Comics & Panels", group: "medium" },
  { name: "Photography", group: "medium" },
  { name: "Video & Short Clips", group: "medium" },
  { name: "Voice & Audio", group: "medium" },
  { name: "Writing & Stories", group: "medium" },
  { name: "Music & Sound", group: "medium" },
  { name: "Cosplay", group: "medium" },
  { name: "Crafts & Physical Goods", group: "medium" },
  { name: "Character Design & OCs", group: "subject" },
  { name: "Fan Art", group: "subject" },
  { name: "Furry & Anthro", group: "subject" },
  { name: "Anime & Manga Style", group: "subject" },
  { name: "Fantasy", group: "subject" },
  { name: "Sci-Fi", group: "subject" },
  { name: "Horror & Dark", group: "subject" },
  { name: "Romance", group: "subject" },
  { name: "Pin-up & Glamour", group: "subject" },
  { name: "Portraits", group: "subject" },
  { name: "Landscapes & Scenes", group: "subject" },
  { name: "Tattoo Designs", group: "subject" },
  { name: "Reference Sheets", group: "subject" },
  { name: "VTuber & Stream Assets", group: "subject" },
  { name: "Live Sessions", group: "subject" },
];
const CATEGORY_SET = new Set(CATEGORY_TAXONOMY.map(c => c.name));
const MAX_CATEGORIES = 6;
const taxonomyOut = z.object({ name: z.string(), group: z.string() });

/* ---- Model v2: levels from lifetime-earned standing ----
   Standing is the game layer: earned only, never purchasable, never
   transferable, no cash value. Lifetime earned (never the spendable
   balance) sets the level; levels gate quote caps and Vault access. */
const LEVELS = [
  { level: 1, name: "Newcomer", min: 0, cap: 75 },
  { level: 2, name: "Established", min: 100, cap: 200 },
  { level: 3, name: "Trusted", min: 300, cap: 600 },
  { level: 4, name: "Seasoned", min: 750, cap: 2000 },
  { level: 5, name: "Pillar", min: 1500, cap: 0 },
] as const;
function levelOf(lifetime: number): { level: number; name: string; cap: number; nextMin: number | null } {
  let cur: (typeof LEVELS)[number] = LEVELS[0];
  for (const l of LEVELS) if (lifetime >= l.min) cur = l;
  const idx = LEVELS.indexOf(cur);
  const next = LEVELS[idx + 1];
  return { level: cur.level, name: cur.name, cap: cur.cap, nextMin: next ? next.min : null };
}
/* Coherent sample stats for the five unowned demo shops, consistent with
   their seeded jobs and prices (display-only; real accounts compute live). */
const SAMPLE_STATS: Record<string, { jobs: number; onTime: number; lifetime: number; verified: boolean }> = {
  velvetine: { jobs: 34, onTime: 96, lifetime: 820, verified: true },
  mothlight: { jobs: 27, onTime: 93, lifetime: 340, verified: true },
  goldleaf: { jobs: 19, onTime: 89, lifetime: 310, verified: true },
  echovale: { jobs: 8, onTime: 100, lifetime: 120, verified: false },
  inkbound: { jobs: 12, onTime: 92, lifetime: 180, verified: false },
};
const paymentMethodOut = z.object({ label: z.string(), link: z.string(), instructions: z.string() });
/* ---- Crypto rail (Colin, 2026-11-14): sellers may ALSO list crypto
   wallets alongside external payment links, and each seller chooses which
   rails their page offers. Buyers must already hold the crypto and send it
   THEMSELVES, wallet → wallet; the platform never buys, sells, holds,
   forwards or converts value in any currency, for any duration — it only
   displays the seller's public address and reads the buyer's submitted
   transaction ID through the (beta: simulated) transaction checker, which
   then releases the next step automatically. Addresses are PUBLIC receive
   addresses only — private keys and seed phrases are never asked for and
   are rejected on sight by the pattern screen below. ---- */
export const CRYPTO_NETWORKS: { id: string; name: string; addressHint: string }[] = [
  { id: "btc", name: "Bitcoin (BTC)", addressHint: "Starts with 1, 3 or bc1" },
  { id: "ltc", name: "Litecoin (LTC)", addressHint: "Starts with L, M, 3 or ltc1" },
  { id: "usdt-tron", name: "USDT (TRON / TRC-20)", addressHint: "Starts with T" },
  { id: "usdt-eth", name: "USDT (Ethereum / ERC-20)", addressHint: "Starts with 0x" },
  { id: "eth", name: "Ethereum (ETH)", addressHint: "Starts with 0x" },
  { id: "xmr", name: "Monero (XMR)", addressHint: "Starts with 4 or 8" },
  { id: "sol", name: "Solana (SOL)", addressHint: "Base58 address" },
  { id: "doge", name: "Dogecoin (DOGE)", addressHint: "Starts with D" },
];
const CRYPTO_NETWORK_IDS = new Set(CRYPTO_NETWORKS.map(n => n.id));
const cryptoWalletOut = z.object({ network: z.string(), address: z.string(), label: z.string() });
type CryptoWallet = z.infer<typeof cryptoWalletOut>;
/** Loose per-network PUBLIC address shape check. Deliberately permissive
    (wallets vary) but hard-rejects anything that looks like a private key
    or seed phrase — those must never be stored here. */
function checkWalletAddress(network: string, address: string): void {
  const a = address.trim();
  if (/\s/.test(a) || a.length < 26 || a.length > 128) throw new Error("That doesn't look like a public wallet address — addresses are a single string with no spaces. Never paste a private key or seed phrase here.");
  const ok =
    network === "btc" ? /^(1|3|bc1)[a-zA-Z0-9]{20,71}$/.test(a) :
    network === "ltc" ? /^(L|M|3|ltc1)[a-zA-Z0-9]{20,71}$/.test(a) :
    network === "usdt-tron" ? /^T[a-zA-Z0-9]{33}$/.test(a) :
    network === "usdt-eth" || network === "eth" ? /^0x[a-fA-F0-9]{40}$/.test(a) :
    network === "xmr" ? /^[48][a-zA-Z0-9]{94}$/.test(a) :
    network === "sol" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) :
    network === "doge" ? /^D[a-zA-Z0-9]{33}$/.test(a) : false;
  if (!ok) throw new Error(`That address doesn't match the shape of a ${CRYPTO_NETWORKS.find(n => n.id === network)?.name ?? network} public address. Double-check the network and the address — and never paste a private key or seed phrase.`);
}
/** Transaction-ID shape per network (the checker's first gate). */
function checkTxid(network: string, txid: string): void {
  const t = txid.trim();
  const ok =
    network === "usdt-eth" || network === "eth" ? /^0x[a-fA-F0-9]{64}$/.test(t) :
    network === "sol" ? /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(t) :
    /^[a-fA-F0-9]{64}$/.test(t);
  if (!ok) throw new Error("That doesn't look like a transaction ID for this network — copy the full transaction hash from your wallet or the block explorer and paste it exactly.");
}
const creatorOut = z.object({ id: z.string(), name: z.string(), handle: z.string(), tagline: z.string(), accent: z.string(), bio: z.string(), status: z.string(), turnaround: z.string(), prices: z.array(z.object({ label: z.string(), price: z.number() })), willDo: z.array(z.string()), wontDo: z.array(z.string()), portfolio: z.array(z.object({ title: z.string(), kind: z.string(), hue: z.number() })), pfpUrl: z.string(), bannerUrl: z.string(), bgColor: z.string(), panelColor: z.string(), accent2: z.string(), headingColor: z.string(), bodyColor: z.string(), bgImageUrl: z.string(), showcaseUrl: z.string(), portfolioImages: z.record(z.string(), z.string()), hasOwner: z.boolean(), categories: z.array(z.string()), paymentMethods: z.array(paymentMethodOut), cryptoWallets: z.array(cryptoWalletOut), verifiedOnly: z.boolean(), verified: z.boolean(), jobsCompleted: z.number(), onTimePct: z.number(), level: z.number(), levelName: z.string(), bannerFrame: z.boolean(), nameGlow: z.boolean(), extraPortfolioTiles: z.number(), extraVaultSlots: z.number() });
const commissionOut = z.object({ id: z.string(), creatorId: z.string(), buyerName: z.string(), title: z.string(), brief: z.string(), refsText: z.string(), budget: z.number(), price: z.number(), kind: z.string(), rail: z.string(), status: z.string(), deadline: z.string().nullable(), sketchApproved: z.boolean(), revisionsUsed: z.number(), revisionsTotal: z.number(), deliveredNote: z.string(), disputeReason: z.string(), counterPrice: z.number().nullable(), blocksTotal: z.number(), blocksReleased: z.number(), blockAmount: z.number(), createdAt: z.string(), isV2: z.boolean(), depositAmount: z.number(), depositConfirmed: z.boolean(), sketchImageUrl: z.string(), sketchSubmittedAt: z.string().nullable(), vaultPreviewUrl: z.string(), vaultFileName: z.string(), hasVaultFile: z.boolean(), vaultDeliveredAt: z.string().nullable(), unlockedAt: z.string().nullable(), downloadCount: z.number(), ghostReleased: z.boolean(), escalated: z.boolean(), payMethod: z.string(), depositTx: z.string(), depositTxConfirmed: z.boolean(), balanceTx: z.string(), balanceTxConfirmed: z.boolean() });
const ledgerOut = z.object({ id: z.number(), commissionId: z.string(), label: z.string(), fromState: z.string(), toState: z.string(), amount: z.number(), note: z.string(), createdAt: z.string() });
const lotOut = z.object({ id: z.string(), title: z.string(), theme: z.string(), reserve: z.number(), currentBid: z.number(), bidder: z.string(), status: z.string() });
const itemOut = z.object({ id: z.string(), lotId: z.string(), creatorName: z.string(), title: z.string(), kind: z.string(), door: z.string(), shares: z.number(), mediaUrl: z.string(), status: z.string() });

type CreatorRow = typeof schema.creators.$inferSelect;
type CommRow = typeof schema.commissions.$inferSelect;
type CreatorExtra = { verified: boolean; jobsCompleted: number; onTimePct: number; lifetime: number };
function mapCreator(r: CreatorRow, hasOwner = false, categories: string[] = [], extra?: CreatorExtra): z.infer<typeof creatorOut> { const qTitles = new Set(parseJson<string[]>(r.portfolioQuarantineJson ?? "[]", [])); const portfolio = parseJson<{ title: string; kind: string; hue: number }[]>(r.portfolioJson, []).filter(p => !qTitles.has(p.title)); const allImages = parseJson<Record<string, string>>(r.portfolioImagesJson ?? "{}", {}); const portfolioImages: Record<string, string> = {}; for (const [k, v] of Object.entries(allImages)) if (!qTitles.has(k)) portfolioImages[k] = mediaUrlOf(v); const sample = SAMPLE_STATS[r.id]; const ex: CreatorExtra = extra ?? (sample ? { verified: sample.verified, jobsCompleted: sample.jobs, onTimePct: sample.onTime, lifetime: sample.lifetime } : { verified: false, jobsCompleted: 0, onTimePct: 100, lifetime: 0 }); const lv = levelOf(ex.lifetime); return { id: r.id, name: r.name, handle: r.handle, tagline: r.tagline, accent: r.accent, bio: r.bio, status: r.status, turnaround: r.turnaround, prices: parseJson(r.pricesJson, []), willDo: parseJson(r.willDoJson, []), wontDo: parseJson(r.wontDoJson, []), portfolio, pfpUrl: mediaUrlOf(r.pfpUrl ?? ""), bannerUrl: mediaUrlOf(r.bannerUrl ?? ""), bgColor: r.bgColor ?? "#fffef9", panelColor: r.panelColor ?? "#ffffff", accent2: r.accent2 ?? "#facc15", headingColor: r.headingColor ?? "#334155", bodyColor: r.bodyColor ?? "#475569", bgImageUrl: mediaUrlOf(r.bgImageUrl ?? ""), showcaseUrl: mediaUrlOf(r.showcaseUrl ?? ""), portfolioImages, hasOwner, categories, paymentMethods: parseJson<{ label: string; link: string; instructions: string }[]>(r.paymentMethodsJson ?? "[]", []), cryptoWallets: parseJson<CryptoWallet[]>(r.cryptoWalletsJson ?? "[]", []).filter(w => CRYPTO_NETWORK_IDS.has(w.network)), verifiedOnly: r.verifiedOnly === 1, verified: ex.verified, jobsCompleted: ex.jobsCompleted, onTimePct: ex.onTimePct, level: lv.level, levelName: lv.name, bannerFrame: r.bannerFrame === 1, nameGlow: r.nameGlow === 1, extraPortfolioTiles: r.extraPortfolioTiles ?? 0, extraVaultSlots: r.extraVaultSlots ?? 0 }; }
function mapComm(r: CommRow): z.infer<typeof commissionOut> { return { id: r.id, creatorId: r.creatorId, buyerName: r.buyerName, title: r.title, brief: r.brief, refsText: r.refsText, budget: r.budget, price: r.price, kind: r.kind, rail: r.rail, status: r.status, deadline: r.deadline ? r.deadline.toISOString() : null, sketchApproved: r.sketchApproved === 1, revisionsUsed: r.revisionsUsed, revisionsTotal: r.revisionsTotal, deliveredNote: r.deliveredNote, disputeReason: r.disputeReason, counterPrice: r.counterPrice ?? null, blocksTotal: r.blocksTotal, blocksReleased: r.blocksReleased, blockAmount: r.blockAmount, createdAt: r.createdAt.toISOString(), isV2: r.v2 === 1, depositAmount: r.depositAmount ?? 0, depositConfirmed: r.depositConfirmed === 1, sketchImageUrl: mediaUrlOf(r.sketchImageUrl ?? ""), sketchSubmittedAt: r.sketchSubmittedAt ? r.sketchSubmittedAt.toISOString() : null, vaultPreviewUrl: mediaUrlOf(r.vaultPreviewUrl ?? ""), vaultFileName: r.vaultFileName ?? "", hasVaultFile: !!r.vaultFileUrl, vaultDeliveredAt: r.vaultDeliveredAt ? r.vaultDeliveredAt.toISOString() : null, unlockedAt: r.unlockedAt ? r.unlockedAt.toISOString() : null, downloadCount: r.downloadCount ?? 0, ghostReleased: r.ghostReleased === 1, escalated: r.escalated === 1, payMethod: r.payMethod ?? "", depositTx: r.depositTx ?? "", depositTxConfirmed: r.depositTxConfirmed === 1, balanceTx: r.balanceTx ?? "", balanceTxConfirmed: r.balanceTxConfirmed === 1 }; }
/** The crypto network a job pays on, or "" for external/direct payments. */
function cryptoNetworkOf(c: CommRow): string { return c.payMethod && c.payMethod.startsWith("crypto:") ? c.payMethod.slice("crypto:".length) : ""; }

async function addLedger(ctx: AppCtx, commissionId: string, label: string, fromState: string, toState: string, amount: number, note: string) {
  const db = ctx.db;
  await db.insert(schema.ledgerEntries).values({ commissionId, label, fromState, toState, amount, note });
}

const stateResponse = z.object({ creators: z.array(creatorOut), commissions: z.array(commissionOut), ledger: z.array(ledgerOut), lots: z.array(lotOut), items: z.array(itemOut), taxonomy: z.array(taxonomyOut) });

/* ---- Public search DTO: ONLY what a storefront already shows publicly.
   No emails, no password hashes, no session tokens, no account internals —
   this shape is the whole payload, enforced by the response schema. ---- */
const searchResultOut = z.object({ slug: z.string(), creatorId: z.string(), displayName: z.string(), username: z.string(), handle: z.string(), pfpUrl: z.string(), bannerUrl: z.string(), accent: z.string(), tagline: z.string(), categories: z.array(z.string()), status: z.string(), verified: z.boolean(), level: z.number(), levelName: z.string() });
const searchResponse = z.object({ results: z.array(searchResultOut), total: z.number() });

/** Escape LIKE wildcards so a visitor's %, _ and \ are literal characters,
    never pattern magic. The escape character itself travels as a bound
    parameter (ESC below) rather than a SQL string literal. */
function escapeLike(term: string): string { return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_"); }
const LIKE_ESC = "\\";
const okResponse = z.object({ ok: z.literal(true), id: z.string().optional(), message: z.string().optional() });

/* ---- Accounts & sessions (prototype auth) ----
   Passwords are stored ONLY as a salted scrypt hash ("salt:hash", hex) —
   never plaintext, never returned to the client. Sessions are random
   tokens persisted server-side so a login survives refresh. */
/* ---- Public post DTO: ONLY public storefront fields (name, handle,
   username, pfp, accent) plus the post itself. No emails/hashes/tokens. ---- */
const postOut = z.object({ id: z.string(), creatorId: z.string(), creatorSlug: z.string(), creatorName: z.string(), username: z.string(), handle: z.string(), pfpUrl: z.string(), accent: z.string(), title: z.string(), body: z.string(), priceNote: z.string(), imageUrl: z.string(), videoUrl: z.string(), categories: z.array(z.string()), createdAt: z.string(), creatorVerified: z.boolean() });
const feedResponse = z.object({ posts: z.array(postOut), total: z.number() });

/* ---- Admin DTOs (test-readiness pack). These shapes are ONLY ever
   returned to a verified admin session — adminGetState re-checks admin
   server-side before building any of them. ---- */
const inviteOut = z.object({ id: z.string(), code: z.string(), maxUses: z.number(), usesCount: z.number(), disabled: z.boolean(), createdAt: z.string() });
const adminAccountOut = z.object({ id: z.string(), displayName: z.string(), username: z.string(), email: z.string(), accountType: z.string(), creatorId: z.string().nullable(), isBanned: z.boolean(), isOwner: z.boolean(), role: z.string(), refundDebt: z.number(), credits: z.number(), createdAt: z.string(), verified: z.boolean(), lifetimeEarned: z.number(), level: z.number(), levelName: z.string(), strikes: z.number(), banEvasionFlag: z.boolean() });
const refundJobOut = z.object({ id: z.string(), title: z.string(), status: z.string(), price: z.number(), depositAmount: z.number(), buyerName: z.string(), creatorName: z.string(), escalated: z.boolean(), covered: z.boolean() });
const ghostJobOut = z.object({ id: z.string(), title: z.string(), unlockedAt: z.string(), downloadCount: z.number(), ghostReleased: z.boolean(), daysUntilGhost: z.number() });
const reportOut = z.object({ id: z.string(), targetType: z.string(), targetId: z.string(), itemTitle: z.string(), targetLabel: z.string(), targetHref: z.string(), reason: z.string(), detail: z.string(), status: z.string(), createdAt: z.string() });
const quarantineOut = z.object({ targetType: z.string(), targetId: z.string(), itemTitle: z.string(), title: z.string(), ownerLabel: z.string(), note: z.string(), quarantinedAt: z.string() });
const modLogOut = z.object({ id: z.number(), actorLabel: z.string(), action: z.string(), targetType: z.string(), targetId: z.string(), note: z.string(), createdAt: z.string() });
const adminStateResponse = z.object({ invites: z.array(inviteOut), accounts: z.array(adminAccountOut), reports: z.array(reportOut), quarantine: z.array(quarantineOut), log: z.array(modLogOut), ghostJobs: z.array(ghostJobOut), refundJobs: z.array(refundJobOut) });
const REPORT_REASONS = ["Illegal or unsafe content", "Non-consensual or assault material", "Spam or scam", "Copyright — not their work", "Harassment", "Other"] as const;
type PostRow = typeof schema.posts.$inferSelect;
type PostOut = z.infer<typeof postOut>;
function mapPost(r: PostRow, c: CreatorRow, username: string, categories: string[], creatorVerified = false): PostOut {
  return { id: r.id, creatorId: r.creatorId, creatorSlug: slugifyServer(c.name) || c.id, creatorName: c.name, username, handle: c.handle, pfpUrl: mediaUrlOf(c.pfpUrl ?? ""), accent: c.accent, title: r.title, body: r.body, priceNote: r.priceNote ?? "", imageUrl: mediaUrlOf(r.imageUrl ?? ""), videoUrl: mediaUrlOf(r.videoUrl ?? ""), categories, createdAt: r.createdAt.toISOString(), creatorVerified };
}
/** Load posts (already ordered) with their creator, username and category
    rows attached — shared by the public feed and the owner's own list. */
async function loadPosts(ctx: AppCtx, rows: PostRow[]): Promise<PostOut[]> {
  if (rows.length === 0) return [];
  const db = ctx.db;
  const creatorIds = [...new Set(rows.map(r => r.creatorId))];
  const postIds = rows.map(r => r.id);
  const creatorRows = await db.select().from(schema.creators).where(inArray(schema.creators.id, creatorIds));
  const creatorById = new Map(creatorRows.map(c => [c.id, c]));
  const acctRows = await db.select({ creatorId: schema.accounts.creatorId, username: schema.accounts.username }).from(schema.accounts).where(inArray(schema.accounts.creatorId, creatorIds));
  const userByCreator = new Map<string, string>();
  for (const a of acctRows) if (a.creatorId) userByCreator.set(a.creatorId, a.username);
  const catRows = await db.select().from(schema.postCategories).where(inArray(schema.postCategories.postId, postIds));
  const catsByPost = new Map<string, string[]>();
  for (const r of catRows) { const arr = catsByPost.get(r.postId) ?? []; arr.push(r.category); catsByPost.set(r.postId, arr); }
  const bannedIds = await bannedCreatorIds(ctx);
  const verifiedRows = await db.select({ creatorId: schema.accounts.creatorId, verified: schema.accounts.verified }).from(schema.accounts).where(inArray(schema.accounts.creatorId, creatorIds));
  const verifiedByCreator = new Map<string, boolean>();
  for (const a of verifiedRows) if (a.creatorId) verifiedByCreator.set(a.creatorId, a.verified === 1);
  const out: PostOut[] = [];
  for (const r of rows) {
    if (r.quarantined === 1) continue; // quarantined posts are evidence, not feed content
    const c = creatorById.get(r.creatorId);
    if (!c) continue; // orphaned post (creator gone) — never surfaced
    if (c.quarantined === 1 || bannedIds.has(c.id)) continue; // hidden page = hidden posts
    const verified = verifiedByCreator.get(r.creatorId) ?? (SAMPLE_STATS[r.creatorId]?.verified ?? false);
    out.push(mapPost(r, c, userByCreator.get(r.creatorId) ?? c.handle.replace(/^@/, ""), catsByPost.get(r.id) ?? [], verified));
  }
  return out;
}
const strikeOut = z.object({ note: z.string(), createdAt: z.string() });
const accountOut = z.object({ id: z.string(), displayName: z.string(), username: z.string(), email: z.string(), accountType: z.string(), creatorId: z.string().nullable(), creatorSlug: z.string().nullable(), credits: z.number(), isAdmin: z.boolean(), role: z.string(), refundDebt: z.number(), verified: z.boolean(), lifetimeEarned: z.number(), level: z.number(), levelName: z.string(), nextLevelAt: z.number().nullable(), strikes: z.array(strikeOut), perks: z.object({ bannerFrame: z.boolean(), nameGlow: z.boolean(), extraPortfolioTiles: z.number(), extraVaultSlots: z.number() }) });
const authResponse = z.object({ csrfToken: z.string(), account: accountOut });
function slugifyServer(s: string): string { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

export async function accountPayload(ctx: AppCtx, a: AccountRow): Promise<z.infer<typeof accountOut>> {
  const db = ctx.db;
  let creatorSlug: string | null = null;
  let perks = { bannerFrame: false, nameGlow: false, extraPortfolioTiles: 0, extraVaultSlots: 0 };
  if (a.creatorId) {
    const rows = await db.select().from(schema.creators).where(eq(schema.creators.id, a.creatorId));
    const c = rows[0];
    if (c) { creatorSlug = slugifyServer(c.name) || c.id; perks = { bannerFrame: c.bannerFrame === 1, nameGlow: c.nameGlow === 1, extraPortfolioTiles: c.extraPortfolioTiles ?? 0, extraVaultSlots: c.extraVaultSlots ?? 0 }; }
  }
  const strikeRows = await db.select().from(schema.strikes).where(eq(schema.strikes.accountId, a.id)).orderBy(desc(schema.strikes.createdAt));
  const lv = levelOf(a.lifetimeEarned ?? 0);
  return { id: a.id, displayName: a.displayName, username: a.username, email: a.email, accountType: a.accountType, creatorId: a.creatorId ?? null, creatorSlug, credits: a.credits ?? 0, isAdmin: isAdminAccount(a), role: roleOf(a), refundDebt: a.refundDebt ?? 0, verified: a.verified === 1, lifetimeEarned: a.lifetimeEarned ?? 0, level: lv.level, levelName: lv.name, nextLevelAt: lv.nextMin, strikes: strikeRows.map(st => ({ note: st.note, createdAt: st.createdAt.toISOString() })), perks };
}

/* ---- Standing earn helper (game layer) ----
   Every earn is a standing_events row AND a job ledger row when a job is
   involved, so the movement is auditable from both sides. Lifetime earned
   only ever grows (except a ban burn); the spendable balance is credits. */
async function earnStanding(ctx: AppCtx, accountId: string, commissionId: string, kind: string, points: number, note: string): Promise<void> {
  const db = ctx.db;
  const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
  const a = rows[0]; if (!a) return;
  await db.insert(schema.standingEvents).values({ accountId, commissionId, kind, points, note });
  await db.update(schema.accounts).set({ credits: (a.credits ?? 0) + points, lifetimeEarned: (a.lifetimeEarned ?? 0) + points }).where(eq(schema.accounts.id, accountId));
  if (commissionId) await addLedger(ctx, commissionId, `Standing earned — ${note}`, "Standing", "Standing", points, `${points} standing to @${a.username}. Standing is earned only: never purchasable, never transferable, no cash value.`);
}
async function hasStandingEvent(ctx: AppCtx, accountId: string, kind: string, commissionId = ""): Promise<boolean> {
  const db = ctx.db;
  const rows = await db.select().from(schema.standingEvents).where(eq(schema.standingEvents.accountId, accountId));
  return rows.some(r => r.kind === kind && (commissionId === "" || r.commissionId === commissionId));
}

/* ---- Owner / admin (test-readiness pack) ----
   The owner account is decided by OWNER_EMAIL (env, trim/lowercase,
   fail-closed when unset — see auth.ts) server-side only. The flag
   follows that account (synced onto the row at session resolution);
   there is no other path to admin and no client input can set it.
   is_admin never appears in any public payload — the only place it
   surfaces is the account's OWN session payload, as the "you are admin"
   indicator. Roles (Colin, 2026-11-14): the owner's account is the DEV
   account; dev appoints MODERATOR accounts later. Dev = everything
   (invites, roles, refund debt, Trust Pool covers, verify, standing
   grants). Mod = the day-to-day moderation set (reports, quarantine,
   restore, delete, dismiss, strikes, bans) but NOT invites, roles,
   debt, covers or grants. Identity comes from the session cookie via
   ctx.account — handlers never see a client-supplied token. */
function requireAccount(ctx: AppCtx): AccountRow {
  if (!ctx.account) throw new Error("Please log in first — your session may have expired.");
  return ctx.account;
}
function requireAdmin(ctx: AppCtx): AccountRow {
  const a = requireAccount(ctx);
  if (!isAdminAccount(a)) throw new Error("That page couldn't be found.");
  return a;
}
/** Staff gate for the moderation surface: dev OR moderator. */
function requireStaff(ctx: AppCtx): AccountRow {
  const a = requireAccount(ctx);
  if (roleOf(a) === "member") throw new Error("That page couldn't be found.");
  return a;
}
async function addModLog(ctx: AppCtx, actor: AccountRow, action: string, targetType: string, targetId: string, note: string): Promise<void> {
  const db = ctx.db;
  await db.insert(schema.moderationLog).values({ actorId: actor.id, actorLabel: `@${actor.username}`, action, targetType, targetId, note });
}
/** Creator ids whose owning account is banned — their pages and posts are
    hidden from every public surface while the ban stands. */
async function bannedCreatorIds(ctx: AppCtx): Promise<Set<string>> {
  const db = ctx.db;
  const rows = await db.select({ creatorId: schema.accounts.creatorId }).from(schema.accounts).where(eq(schema.accounts.isBanned, 1));
  return new Set(rows.map(r => r.creatorId).filter((x): x is string => !!x));
}
/** Mints a session for an account and hands the router what it needs:
    the raw token goes ONLY into the HttpOnly session cookie (via
    ctx.setSessionCookie); the CSRF token rides the auth response. Only
    the token's SHA-256 hash is stored — a leaked DB row can't be
    replayed as a session. A fresh token is minted at every login
    (session-fixation defence). */
async function startSession(ctx: AppCtx, accountId: string): Promise<void> {
  const s = await createSession(ctx.db, accountId);
  ctx.setSessionCookie = s.rawToken;
  ctx.csrfToken = s.csrfToken;
}
/* ---- Media values (standalone) ----
   Uploaded media is stored as asset references ("asset:<id>"); DTO
   mappers expose them as /media/<id> URLs. Data URLs are no longer
   accepted anywhere — media moves through the upload flow only
   (CONTRACT.md). External http(s) image links remain allowed exactly
   where they were. */
/** Stored value -> public URL (asset refs become /media/<id>). */
export function mediaUrlOf(v: string): string {
  if (!v) return "";
  return v.startsWith("asset:") ? `/media/${v.slice("asset:".length)}` : v;
}
/** Public URL (or raw ref) -> stored value. */
export function refOf(v: string): string {
  if (!v) return "";
  return v.startsWith("/media/") ? `asset:${v.slice("/media/".length)}` : v;
}
/** Image inputs: an uploaded asset reference (or its /media/ URL form),
    or a plain http(s) link. NO SVG, no data URLs. */
function checkImageValue(v: string, label: string): void {
  if (!v) return;
  if (/^asset:[A-Za-z0-9_-]+$/.test(v)) return;
  if (/^\/media\/[A-Za-z0-9_-]+$/.test(v)) return;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(v)) return;
  throw new Error(`${label}: only image uploads or http(s) image links are allowed here.`);
}
/** Video inputs are a stricter surface: uploaded asset references only,
    no remote URLs. (The name is kept from the data-URL era; the upload
    flow enforces the ~2 MB byte cap server-side.) */
const MAX_VIDEO_DATAURL = 2_800_000;
function checkVideoValue(v: string, label: string): void {
  if (!v) return;
  if (/^asset:[A-Za-z0-9_-]+$/.test(v)) return;
  if (/^\/media\/[A-Za-z0-9_-]+$/.test(v)) return;
  throw new Error(`${label}: only small MP4 uploads are allowed here.`);
}
/** Binding check: an asset value must point at a READY asset of an
    allowed kind owned by the given account — somebody else's upload id
    can't be bound to your page, post or job. Non-asset values (external
    http(s) image links) pass through untouched. Seed assets (owner
    null) are display content and are never bindable through actions. */
async function assertAsset(ctx: AppCtx, value: string, kinds: string[], ownerId: string, label: string): Promise<void> {
  if (!value) return;
  const ref = refOf(value);
  if (!ref.startsWith("asset:")) return;
  const id = ref.slice("asset:".length);
  const rows = await ctx.db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id));
  const a = rows[0];
  if (!a || a.ready !== 1 || a.deletedAt) throw new Error(`${label}: that upload couldn't be found — try uploading it again.`);
  if (!kinds.includes(a.kind)) throw new Error(`${label}: that file can't be used here.`);
  if (a.ownerAccountId !== ownerId) throw new Error(`${label}: that upload belongs to a different account.`);
}

export const Actions = {
  getState: defineAction({
    description: "Returns all prototype state: creators, commissions, ledger, auction lots and items.",
    request: z.object({}),
    response: stateResponse,
    async handler(ctx): Promise<z.infer<typeof stateResponse>> {
      const db = ctx.db;
      const bannedIds = await bannedCreatorIds(ctx);
      const allCreators = await db.select().from(schema.creators).orderBy(asc(schema.creators.name));
      /* Quarantined creator pages and banned owners' pages vanish from
         every public surface — getState feeds the directory, creator
         pages and pickers, so filtering here covers them all. */
      const creators = allCreators.filter(c => c.quarantined !== 1 && !bannedIds.has(c.id));
      const acctRows = await db.select().from(schema.accounts);
      const ownedIds = new Set(acctRows.map(a => a.creatorId).filter((x): x is string => !!x));
      const allCommissions = await db.select().from(schema.commissions).orderBy(desc(schema.commissions.createdAt));
      const allLedger = await db.select().from(schema.ledgerEntries).orderBy(asc(schema.ledgerEntries.id));
      /* Plan §4.1.1 — the getState split: a job involving a real account
         (and its ledger rows) is visible only to its buyer of record,
         its artist, or staff. Demo jobs with no real account on either
         side stay publicly readable as display-only content — the Jobs
         page is a demo surface and that data is fictional. extraFor
         below keeps using the full list so public creator stats stay
         coherent. */
      const caller = ctx.account;
      const callerIsStaff = caller ? roleOf(caller) !== "member" : false;
      const jobVisible = (cm: CommRow): boolean => {
        const hasRealParty = !!cm.buyerAccountId || ownedIds.has(cm.creatorId);
        if (!hasRealParty) return true;
        if (!caller) return false;
        if (callerIsStaff) return true;
        if (cm.buyerAccountId && cm.buyerAccountId === caller.id) return true;
        if (caller.creatorId && caller.creatorId === cm.creatorId) return true;
        return false;
      };
      const commissions = allCommissions.filter(jobVisible);
      const visibleJobIds = new Set(commissions.map(cm => cm.id));
      const ledger = allLedger.filter(r => visibleJobIds.has(r.commissionId));
      const lots = await db.select().from(schema.auctionLots).orderBy(asc(schema.auctionLots.createdAt));
      const allItems = await db.select().from(schema.auctionItems).orderBy(asc(schema.auctionItems.createdAt));
      const items = allItems.filter(i => i.quarantined !== 1);
      const catRows = await db.select().from(schema.creatorCategories);
      const catsByCreator = new Map<string, string[]>();
      for (const r of catRows) { const arr = catsByCreator.get(r.creatorId) ?? []; arr.push(r.category); catsByCreator.set(r.creatorId, arr); }
      /* v2 public stats: owned creators compute live from their account +
         job history; sample shops use SAMPLE_STATS in mapCreator. */
      const acctByCreator = new Map<string, AccountRow>();
      for (const a of acctRows) if (a.creatorId) acctByCreator.set(a.creatorId, a);
      const extraFor = (c: CreatorRow): CreatorExtra | undefined => {
        const a = acctByCreator.get(c.id);
        if (!a) return undefined;
        const mine = allCommissions.filter(cm => cm.creatorId === c.id);
        const done = mine.filter(cm => cm.status === "released" || cm.status === "unlocked");
        const onTime = done.filter(cm => !cm.deadline || cm.status === "unlocked" || (cm.vaultDeliveredAt ? cm.vaultDeliveredAt.getTime() <= (cm.deadline?.getTime() ?? Infinity) : true));
        return { verified: a.verified === 1, jobsCompleted: done.length, onTimePct: done.length === 0 ? 100 : Math.round((onTime.length / done.length) * 100), lifetime: a.lifetimeEarned ?? 0 };
      };
      return {
        creators: creators.map(c => mapCreator(c, ownedIds.has(c.id), catsByCreator.get(c.id) ?? [], extraFor(c))),
        commissions: commissions.map(mapComm),
        ledger: ledger.map(r => ({ id: r.id, commissionId: r.commissionId, label: r.label, fromState: r.fromState, toState: r.toState, amount: r.amount, note: r.note, createdAt: r.createdAt.toISOString() })),
        lots: lots.map(r => ({ id: r.id, title: r.title, theme: r.theme, reserve: r.reserve, currentBid: r.currentBid, bidder: r.bidder, status: r.status })),
        items: items.map(r => ({ id: r.id, lotId: r.lotId, creatorName: r.creatorName, title: r.title, kind: r.kind, door: r.door, shares: r.shares, mediaUrl: mediaUrlOf(r.mediaUrl ?? ""), status: r.status })),
        taxonomy: CATEGORY_TAXONOMY.map(c => ({ name: c.name, group: c.group })),
      };
    },
  }),

  searchCreators: defineAction({
    description: "Public, SQL-backed search over creator storefronts: case-insensitive partial text match on username/display name/slug, combined (AND) with relational category filters (ANY or ALL), sorted by an allowlisted sort. Returns only public storefront fields.",
    request: z.object({ text: z.string().max(80).default(""), categories: z.array(z.string().max(60)).max(28).default([]), matchMode: z.enum(["any", "all"]).default("any"), sort: z.enum(["relevance", "name", "newest"]).default("relevance") }),
    response: searchResponse,
    async handler(ctx, args): Promise<z.infer<typeof searchResponse>> {
      const db = ctx.db;
      /* Categories are validated against the taxonomy allowlist — an unknown
         value can never reach SQL, and known values only ever travel as
         bound parameters (Drizzle), never string-concatenated SQL. */
      const cats = [...new Set(args.categories)];
      for (const c of cats) if (!CATEGORY_SET.has(c)) throw new Error(`Unknown category: ${c}`);
      const term = args.text.trim().toLowerCase();
      const conds = [];
      /* Moderation visibility: quarantined pages and banned owners never
         appear in search, whatever the query. */
      conds.push(eq(schema.creators.quarantined, 0));
      conds.push(sql`NOT EXISTS (SELECT 1 FROM ${schema.accounts} WHERE ${schema.accounts.creatorId} = ${schema.creators.id} AND ${schema.accounts.isBanned} = 1)`);
      if (term) {
        const pat = `%${escapeLike(term)}%`;
        /* Username lives on the linked account; display name, handle and
           slug (creator id) live on the creator row. All four are matched
           with the same escaped, parameterized LIKE pattern. */
        conds.push(or(
          sql`lower(${schema.creators.name}) LIKE ${pat} ESCAPE ${LIKE_ESC}`,
          sql`lower(${schema.creators.handle}) LIKE ${pat} ESCAPE ${LIKE_ESC}`,
          sql`lower(${schema.creators.id}) LIKE ${pat} ESCAPE ${LIKE_ESC}`,
          sql`EXISTS (SELECT 1 FROM ${schema.accounts} WHERE ${schema.accounts.creatorId} = ${schema.creators.id} AND lower(${schema.accounts.username}) LIKE ${pat} ESCAPE ${LIKE_ESC})`,
        ));
      }
      if (cats.length > 0) {
        if (args.matchMode === "all") {
          /* ALL: the creator must carry EVERY selected category — a grouped
             subquery whose distinct-category count equals the selection. */
          const sub = db.select({ cid: schema.creatorCategories.creatorId }).from(schema.creatorCategories)
            .where(inArray(schema.creatorCategories.category, cats))
            .groupBy(schema.creatorCategories.creatorId)
            .having(eq(countDistinct(schema.creatorCategories.category), cats.length));
          conds.push(inArray(schema.creators.id, sub));
        } else {
          /* ANY: one matching category row is enough. */
          const sub = db.select({ cid: schema.creatorCategories.creatorId }).from(schema.creatorCategories)
            .where(inArray(schema.creatorCategories.category, cats));
          conds.push(inArray(schema.creators.id, sub));
        }
      }
      /* Sort identifiers come from this allowlist only — the client picks a
         key, the server picks the ORDER BY. Nothing is interpolated. */
      const orderBy = args.sort === "name"
        ? [asc(schema.creators.name)]
        : args.sort === "newest"
          ? [desc(schema.creators.createdAt), asc(schema.creators.name)]
          : term
            ? [sql`CASE WHEN lower(${schema.creators.name}) = ${term} OR lower(${schema.creators.handle}) = ${"@" + term} OR lower(${schema.creators.id}) = ${term} OR EXISTS (SELECT 1 FROM ${schema.accounts} WHERE ${schema.accounts.creatorId} = ${schema.creators.id} AND lower(${schema.accounts.username}) = ${term}) THEN 0 WHEN lower(${schema.creators.name}) LIKE ${escapeLike(term) + "%"} ESCAPE ${LIKE_ESC} OR lower(${schema.creators.handle}) LIKE ${"@" + escapeLike(term) + "%"} ESCAPE ${LIKE_ESC} OR lower(${schema.creators.id}) LIKE ${escapeLike(term) + "%"} ESCAPE ${LIKE_ESC} OR EXISTS (SELECT 1 FROM ${schema.accounts} WHERE ${schema.accounts.creatorId} = ${schema.creators.id} AND lower(${schema.accounts.username}) LIKE ${escapeLike(term) + "%"} ESCAPE ${LIKE_ESC}) THEN 1 ELSE 2 END`, asc(schema.creators.name)]
            : [asc(schema.creators.name)];
      const rows = await db.select().from(schema.creators)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(...orderBy);
      if (rows.length === 0) return { results: [], total: 0 };
      const ids = rows.map(r => r.id);
      const catRows = await db.select().from(schema.creatorCategories).where(inArray(schema.creatorCategories.creatorId, ids));
      const catsByCreator = new Map<string, string[]>();
      for (const r of catRows) { const arr = catsByCreator.get(r.creatorId) ?? []; arr.push(r.category); catsByCreator.set(r.creatorId, arr); }
      const acctRows = await db.select({ creatorId: schema.accounts.creatorId, username: schema.accounts.username, verified: schema.accounts.verified, lifetimeEarned: schema.accounts.lifetimeEarned }).from(schema.accounts).where(inArray(schema.accounts.creatorId, ids));
      const userByCreator = new Map<string, string>();
      const acctByCreatorS = new Map<string, { verified: boolean; lifetime: number }>();
      for (const a of acctRows) if (a.creatorId) { userByCreator.set(a.creatorId, a.username); acctByCreatorS.set(a.creatorId, { verified: a.verified === 1, lifetime: a.lifetimeEarned ?? 0 }); }
      const results = rows.map(r => {
        const owned = acctByCreatorS.get(r.id);
        const sample = SAMPLE_STATS[r.id];
        const verified = owned ? owned.verified : (sample?.verified ?? false);
        const lv = levelOf(owned ? owned.lifetime : (sample?.lifetime ?? 0));
        return {
        slug: slugifyServer(r.name) || r.id,
        creatorId: r.id,
        displayName: r.name,
        username: userByCreator.get(r.id) ?? r.handle.replace(/^@/, ""),
        handle: r.handle,
        pfpUrl: mediaUrlOf(r.pfpUrl ?? ""),
        bannerUrl: mediaUrlOf(r.bannerUrl ?? ""),
        accent: r.accent,
        tagline: r.tagline,
        categories: catsByCreator.get(r.id) ?? [],
        status: r.status,
        verified,
        level: lv.level,
        levelName: lv.name,
        };
      });
      return { results, total: results.length };
    },
  }),

  createCommission: defineAction({
    description: "Creates a new commission request in the creator's inbox.",
    request: z.object({ creatorId: z.string(), buyerName: z.string().min(1), title: z.string().min(3), brief: z.string().min(10), refsText: z.string().default(""), budget: z.number().int().min(10).max(5000), kind: z.enum(["standard", "extended"]), revisionsTotal: z.number().int().min(0).max(5).default(2), payMethod: z.string().max(30).default("") }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      /* Standalone (plan §4.1.5): creating a commission requires a
         signed-in buyer — buyer identity comes from the session, never
         the form — so every standalone job is a v2 milestone job linked
         to the buyer of record. */
      const buyerAcct = requireAccount(ctx);
      const buyerAccountId: string | null = buyerAcct.id;
      const buyerName = buyerAcct.displayName;
      /* v2 verified-only gate: a creator who flipped "Verified buyers only"
         takes requests only from verified accounts. The block is checked
         server-side against the buyer's actual verified flag. */
      const creatorRows = await db.select().from(schema.creators).where(eq(schema.creators.id, args.creatorId));
      const targetCreator = creatorRows[0];
      if (!targetCreator) throw new Error("That creator couldn't be found.");
      if (targetCreator.verifiedOnly === 1 && buyerAcct && buyerAcct.verified !== 1) throw new Error("This creator takes requests from verified buyers only. Ask the site owner to verify your account (a quick manual ID check during the beta), then try again.");
      if (targetCreator.verifiedOnly === 1 && !buyerAcct) throw new Error("This creator takes requests from verified buyers only. Log in with a verified account to send a request.");
      /* Refund-debt gate (Colin, 2026-11-14): refunds on direct payments
         are the SELLER's obligation. A seller carrying an unpaid refund
         balance can't take new commissions until it's settled — the debt
         locks the door; it never reaches into anyone's wallet. */
      const sellerAcct = (await db.select().from(schema.accounts).where(eq(schema.accounts.creatorId, args.creatorId)))[0] ?? null;
      if (sellerAcct && (sellerAcct.refundDebt ?? 0) > 0) throw new Error(`This seller has an outstanding refund balance of $${sellerAcct.refundDebt} — new commissions are paused until they settle it. If you're the buyer they owe, the Trust Pool cover is the owner's call from the Admin page.`);
      /* Payment rail for this job: "" / "external" = the artist's external
         payment links; "crypto:<network>" = send-it-yourself crypto to
         the artist's listed wallet on that network. A crypto rail the
         artist doesn't actually offer is rejected. */
      let payMethod = "";
      if (args.payMethod === "external") payMethod = "external";
      else if (args.payMethod.startsWith("crypto:")) {
        const net = args.payMethod.slice("crypto:".length);
        const wallets = parseJson<CryptoWallet[]>(targetCreator.cryptoWalletsJson ?? "[]", []);
        if (!CRYPTO_NETWORK_IDS.has(net) || !wallets.some(w => w.network === net)) throw new Error("That crypto option isn't one this artist offers — pick from the rails on their page.");
        payMethod = `crypto:${net}`;
      } else if (args.payMethod) throw new Error("Unknown payment option — pick from the rails on the artist's page.");
      const id = uid("comm");
      const blocksTotal = args.kind === "extended" ? Math.max(1, Math.ceil(args.budget / 50)) : 1;
      /* Real (signed-in) buyers start the v2 milestone flow at Brief;
         signed-out demo requests keep the legacy requested flow, and the
         seeded demo jobs are untouched either way. */
      const isV2 = buyerAccountId !== null;
      await db.insert(schema.commissions).values({ id, creatorId: args.creatorId, buyerName, title: args.title, brief: args.brief, refsText: args.refsText, budget: args.budget, price: args.budget, kind: args.kind, rail: args.kind === "extended" ? "vault" : "reserve", status: isV2 ? "brief" : "requested", blocksTotal, blocksReleased: 0, blockAmount: 50, revisionsTotal: args.revisionsTotal, buyerAccountId, v2: isV2 ? 1 : 0, payMethod });
      if (isV2) await addLedger(ctx, id, "Brief sent (v2 milestone flow)", "—", "Brief", 0, payMethod.startsWith("crypto:") ? `Pays by crypto (${CRYPTO_NETWORKS.find(n => n.id === payMethod.slice(7))?.name ?? payMethod.slice(7)}): the buyer sends it themselves, wallet to wallet, and the transaction checker confirms each payment — the platform never buys, holds or forwards crypto.` : "Money moves directly between buyer and artist on the artist's own payment account. The platform holds the artwork, the evidence and the reputation — never the money.");
      return { ok: true as const, id };
    },
  }),

  actOnCommission: defineAction({
    description: "Advances a commission through its state machine (accept, reserve, deliver, release, dispute, refund, blocks, etc).",
    request: z.object({ id: z.string(), action: z.enum(["accept", "decline", "counter", "reserve", "fund", "start", "submitSketch", "approveSketch", "requestRevision", "deliver", "approveDelivery", "dispute", "resolveRefund", "resolveRelease", "missDeadline", "releaseBlock"]), counterPrice: z.number().int().positive().optional(), note: z.string().optional() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const rows = await db.select().from(schema.commissions).where(eq(schema.commissions.id, args.id));
      const c = rows[0]; if (!c) throw new Error("Commission not found");
      /* Plan §4.1.2: the legacy flow is demo-only on the standalone
         build. A job linked to a real buyer runs the v2 milestone flow;
         unlinked demo jobs are staff-gated. */
      if (c.buyerAccountId) throw new Error("That job runs on the v2 milestone flow — milestone actions apply to it.");
      requireStaff(ctx);
      const now = new Date();
      const deadline7 = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      let patch: Partial<typeof schema.commissions.$inferInsert> = { updatedAt: now };
      /* ---- Test-credit wiring (play money, real accounts only) ----
         Jobs linked to a buyer account move that account's credits:
         reserve/fund deducts price into the job's held state (insufficient
         balance blocks the move entirely); release pays the creator's
         account; refund/non-delivery returns held credits to the buyer.
         Every movement is a ledger row on the job. Unlinked demo jobs
         (the seeded samples) skip all of this — untouched, as before. */
      const buyerAcct = c.buyerAccountId ? (await db.select().from(schema.accounts).where(eq(schema.accounts.id, c.buyerAccountId)))[0] ?? null : null;
      const creatorAcct = (await db.select().from(schema.accounts).where(eq(schema.accounts.creatorId, c.creatorId)))[0] ?? null;
      let heldNow = c.creditsHeld ?? 0;
      let releasedNow = c.creditsReleased ?? 0;
      const holdCredits = async () => {
        if (!buyerAcct || heldNow > 0) return;
        if ((buyerAcct.credits ?? 0) < c.price) throw new Error(`Not enough test credits to reserve this job — it needs ${c.price} credits and the buyer has ${buyerAcct.credits ?? 0}. The owner can grant more from the Admin page.`);
        await db.update(schema.accounts).set({ credits: (buyerAcct.credits ?? 0) - c.price }).where(eq(schema.accounts.id, buyerAcct.id));
        heldNow = c.price;
        await addLedger(ctx, c.id, "Test credits held from buyer balance", "Available", "Held", c.price, "Play money: moved out of the buyer's test-credit balance into this job's held state. Credits have no cash value.");
      };
      const payCreator = async (amount: number) => {
        if (!buyerAcct || amount <= 0 || heldNow <= 0) return;
        const amt = Math.min(amount, heldNow);
        if (creatorAcct) await db.update(schema.accounts).set({ credits: (creatorAcct.credits ?? 0) + amt }).where(eq(schema.accounts.id, creatorAcct.id));
        heldNow -= amt; releasedNow += amt;
        await addLedger(ctx, c.id, "Test credits released to creator balance", "Held", "Earned", amt, creatorAcct ? "Play money: landed in the creator's test-credit balance on release. Credits have no cash value." : "Play money released; the creator is a sample page with no account, so the credits leave circulation.");
      };
      const refundBuyer = async () => {
        if (!buyerAcct || heldNow <= 0) return;
        const fresh = (await db.select().from(schema.accounts).where(eq(schema.accounts.id, buyerAcct.id)))[0];
        await db.update(schema.accounts).set({ credits: (fresh?.credits ?? buyerAcct.credits ?? 0) + heldNow }).where(eq(schema.accounts.id, buyerAcct.id));
        await addLedger(ctx, c.id, "Test credits refunded to buyer balance", "Held", "Available", heldNow, "Play money: unreleased held credits returned to the buyer's test-credit balance.");
        heldNow = 0;
      };
      switch (args.action) {
        case "accept": patch = { ...patch, status: "accepted", price: c.counterPrice ?? c.price }; break;
        case "decline": patch = { ...patch, status: "declined" }; break;
        case "counter": patch = { ...patch, status: "countered", counterPrice: args.counterPrice ?? c.price + 20 }; break;
        case "reserve": patch = { ...patch, status: "reserved", deadline: deadline7 }; await holdCredits(); await addLedger(ctx, c.id, "Card pre-authorization placed (simulated)", "—", "Reserved", c.price, "Fake processor: buyer's bank freezes the amount. Nothing captured yet. Void = instant unfreeze."); break;
        case "fund": patch = { ...patch, status: "funded", deadline: deadline7 }; await holdCredits(); await addLedger(ctx, c.id, "Paid via biller into vault (simulated)", "—", "Locked", c.price, "Fake biller: funds sit in biller pending balance, locked to this job only."); break;
        case "start": patch = { ...patch, status: "in_progress" }; break;
        case "submitSketch": patch = { ...patch, status: "sketch_review" }; break;
        case "approveSketch": patch = { ...patch, status: "in_progress", sketchApproved: 1 }; await addLedger(ctx, c.id, "Sketch approved", "Locked", "Locked", 0, "Sketch gate passed. Taste disputes after this point go to revisions, not automatic refund."); break;
        case "requestRevision": patch = { ...patch, status: "in_progress", revisionsUsed: Math.min(c.revisionsUsed + 1, c.revisionsTotal) }; break;
        case "deliver": patch = { ...patch, status: "delivered", deliveredNote: args.note ?? "Final files delivered through the platform — watermarked preview shown, full files unlock on release." }; break;
        case "approveDelivery": {
          patch = { ...patch, status: "released" };
          const remaining = c.kind === "extended" ? c.price - c.blocksReleased * c.blockAmount : c.price;
          await addLedger(ctx, c.id, c.rail === "reserve" ? "Authorization captured on delivery" : "Vault released on delivery", c.rail === "reserve" ? "Reserved" : "Locked", "Earned", Math.max(0, remaining), "Buyer confirmed delivery (or review window passed). Creator earnings move to Payout Pending at the biller, then Paid on the biller's schedule.");
          await payCreator(heldNow);
          break;
        }
        case "dispute": patch = { ...patch, status: "disputed", disputeReason: args.note ?? "Buyer says delivered work materially departs from the brief." }; break;
        case "resolveRefund": patch = { ...patch, status: "refunded" }; await addLedger(ctx, c.id, "Dispute resolved — refund", "Locked", "Refunded", c.price - c.blocksReleased * (c.kind === "extended" ? c.blockAmount : 0), "Unreleased funds returned to buyer. Already-released weekly blocks are not clawed back from the vault — see rules."); await refundBuyer(); break;
        case "resolveRelease": patch = { ...patch, status: "released" }; await addLedger(ctx, c.id, "Dispute resolved — release to creator", "Locked", "Earned", c.price, "Delivered work matched the brief and approved sketch."); await payCreator(heldNow); break;
        case "missDeadline": patch = { ...patch, status: "refunded" }; await addLedger(ctx, c.id, "Deadline missed — automatic full refund (standard) / unreleased refund (extended)", "Locked", "Refunded", c.kind === "extended" ? Math.max(0, c.price - c.blocksReleased * c.blockAmount) : c.price, "7-day clock expired with no delivery. Authorization voided or vault funds returned — simulated."); await refundBuyer(); break;
        case "releaseBlock": {
          const next = Math.min(c.blocksReleased + 1, c.blocksTotal);
          const amt = next === c.blocksTotal ? c.price - c.blocksReleased * c.blockAmount : c.blockAmount;
          patch = { ...patch, blocksReleased: next, deadline: deadline7, status: next >= c.blocksTotal ? "delivered" : "in_progress" };
          await addLedger(ctx, c.id, `Block ${next} released`, "Locked", "Milestone Released", Math.max(0, amt), `Weekly cap $50 enforced. Block ${next} of ${c.blocksTotal}.`);
          await payCreator(Math.max(0, amt));
          break;
        }
      }
      if (buyerAcct) patch = { ...patch, creditsHeld: heldNow, creditsReleased: releasedNow };
      await db.update(schema.commissions).set(patch).where(eq(schema.commissions.id, args.id));
      return { ok: true as const, id: args.id };
    },
  }),

  submitAuctionItem: defineAction({
    description: "Submits a fresh or salvage item to the current Weekly Vault lot.",
    request: z.object({ creatorName: z.string().min(1), title: z.string().min(2), kind: z.enum(["picture", "video"]), door: z.enum(["fresh", "salvage"]), picsThisWeek: z.number().int().min(0).max(99).default(0), vidsThisWeek: z.number().int().min(0).max(99).default(0), checklist: z.object({ noLikeness: z.boolean(), noPrivateRefs: z.boolean(), noExclusiveChar: z.boolean(), rightsRetained: z.boolean() }).optional() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db0 = ctx.db;
      /* Standalone: submissions require a signed-in account. Weekly
         Vault submissions are Level 2+, and the per-week slot allowance
         is counted server-side from real rows (10 per kind + purchased
         extra vault slots) — never from client-supplied counts. */
      const me = requireAccount(ctx);
      if ((me.lifetimeEarned ?? 0) < 100) throw new Error("Weekly Vault submissions open at Level 2 (Established, 100 lifetime standing). Finish jobs to earn standing first.");
      let extraSlots = 0;
      if (me.creatorId) { const cr = (await db0.select().from(schema.creators).where(eq(schema.creators.id, me.creatorId)))[0]; extraSlots = cr?.extraVaultSlots ?? 0; }
      const lots0 = await db0.select().from(schema.auctionLots); const lot0 = lots0[0];
      if (lot0) {
        const existing = await db0.select().from(schema.auctionItems).where(eq(schema.auctionItems.lotId, lot0.id));
        const mine = existing.filter(i => i.creatorName === args.creatorName);
        const pics = mine.filter(i => i.kind === "picture").length;
        const vids = mine.filter(i => i.kind === "video").length;
        if (args.kind === "picture" && pics >= 10 + extraSlots) throw new Error(`Weekly limit reached: max ${10 + extraSlots} pictures per creator per week (10 + your extra slots).`);
        if (args.kind === "video" && vids >= 10 + extraSlots) throw new Error(`Weekly limit reached: max ${10 + extraSlots} videos per creator per week (10 + your extra slots).`);
      }
      if (args.door === "salvage") {
        const cl = args.checklist; if (!cl || !cl.noLikeness || !cl.noPrivateRefs || !cl.noExclusiveChar || !cl.rightsRetained) throw new Error("Salvage blocked: all resale-rights checks must pass — no buyer likeness, no private references, no exclusively purchased character/design, and you must retain resale rights.");
      }
      const db = ctx.db;
      const lots = await db.select().from(schema.auctionLots); const lot = lots[0]; if (!lot) throw new Error("No open lot");
      const id = uid("item");
      await db.insert(schema.auctionItems).values({ id, lotId: lot.id, creatorName: args.creatorName, title: args.title, kind: args.kind, door: args.door, shares: args.kind === "video" ? 3 : 1, status: "accepted", checklistJson: JSON.stringify(args.checklist ?? {}) });
      return { ok: true as const, id };
    },
  }),

  placeBid: defineAction({
    description: "Places a simulated bid on a Weekly Vault lot.",
    request: z.object({ lotId: z.string(), bidder: z.string().min(1), amount: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      /* Plan §4.1.4: unauthenticated simulated bidding is OFF on the
         standalone build while the Weekly Vault auction model is
         finalised. Submissions and the lot display still work. */
      throw new Error("Bidding is paused on this build while the Weekly Vault auction model is finalised — submissions and the lot display still work.");
    },
  }),
  updateCreatorTheme: defineAction({
    description: "Saves a creator's profile customization (theme + up to 6 taxonomy categories). Requires a session token and only works on the signed-in account's OWN creator page.",
    request: z.object({ creatorId: z.string(), pfpUrl: z.string().max(900000), bannerUrl: z.string().max(900000), bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), panelColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent2: z.string().regex(/^#[0-9a-fA-F]{6}$/), headingColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), bodyColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), bgImageUrl: z.string().max(900000), showcaseUrl: z.string().max(900000), portfolioImages: z.record(z.string(), z.string().max(900000)), categories: z.array(z.string().max(60)).max(MAX_CATEGORIES).default([]), paymentMethods: z.array(z.object({ label: z.string().max(60), link: z.string().max(300), instructions: z.string().max(300) })).max(3).default([]), cryptoWallets: z.array(z.object({ network: z.string().max(20), address: z.string().max(128), label: z.string().max(60) })).max(4).default([]), verifiedOnly: z.boolean().default(false) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAccount(ctx);
      const db = ctx.db;
      /* Ownership-scoped: a page you don't own is indistinguishable from a
         page that doesn't exist — same "not found" answer either way, so
         creator ids can't be probed. Validation runs only after ownership
         is confirmed. */
      const rows = me.creatorId === args.creatorId ? await db.select().from(schema.creators).where(eq(schema.creators.id, args.creatorId)) : [];
      if (!rows[0]) throw new Error("That page couldn't be found.");
      checkImageValue(args.pfpUrl, "Profile picture");
      checkImageValue(args.bannerUrl, "Banner");
      checkImageValue(args.bgImageUrl, "Background image");
      checkImageValue(args.showcaseUrl, "Showcase image");
      Object.entries(args.portfolioImages).forEach(([k, v]) => checkImageValue(v, `Portfolio image (${k})`));
      /* Standalone binding: uploaded values must be READY assets of the
         right kind owned by THIS account — somebody else's upload id
         can't be bound to your page. External http(s) links pass. */
      await assertAsset(ctx, args.pfpUrl, ["profile"], me.id, "Profile picture");
      await assertAsset(ctx, args.bannerUrl, ["banner"], me.id, "Banner");
      await assertAsset(ctx, args.bgImageUrl, ["background"], me.id, "Background image");
      await assertAsset(ctx, args.showcaseUrl, ["showcase"], me.id, "Showcase image");
      for (const [k, v] of Object.entries(args.portfolioImages)) await assertAsset(ctx, v, ["portfolio"], me.id, `Portfolio image (${k})`);
      /* Categories: every submitted value must be on the fixed taxonomy —
         unknown values are rejected outright, never stored. */
      const cats = [...new Set(args.categories)];
      for (const c of cats) if (!CATEGORY_SET.has(c)) throw new Error(`Unknown category: ${c} — pick from the category list.`);
      /* Payment methods: labels/instructions are plain text; anything in
         the link field must be an http(s) link — the platform stores the
         artist's own payment pointers, never credentials, never funds. */
      const payMethods = args.paymentMethods.map(m => ({ label: m.label.trim(), link: m.link.trim(), instructions: m.instructions.trim() })).filter(m => m.label || m.link || m.instructions);
      for (const m of payMethods) { if (!m.label) throw new Error("Each payment method needs a label (e.g. Ko-fi, Interac e-Transfer)."); if (m.link && !/^https?:\/\/[^\s"'<>]+$/i.test(m.link)) throw new Error("Payment links must be http(s) links — put anything else in the instructions text instead."); }
      /* Crypto wallets: PUBLIC receive addresses only, on known networks.
         The seller chooses their rails — external links, crypto, or both.
         The platform stores the address to DISPLAY it; it never holds a
         key and never sends anything. */
      const wallets: CryptoWallet[] = args.cryptoWallets.map(w => ({ network: w.network.trim(), address: w.address.trim(), label: w.label.trim() })).filter(w => w.network || w.address);
      const seenNetworks = new Set<string>();
      for (const w of wallets) {
        if (!CRYPTO_NETWORK_IDS.has(w.network)) throw new Error(`Unknown crypto network: ${w.network || "(blank)"} — pick from the network list.`);
        if (seenNetworks.has(w.network)) throw new Error("One wallet per network is enough — a second address on the same network would split payments confusingly.");
        seenNetworks.add(w.network);
        checkWalletAddress(w.network, w.address);
      }
      await db.update(schema.creators).set({ pfpUrl: refOf(args.pfpUrl), bannerUrl: refOf(args.bannerUrl), bgColor: args.bgColor, panelColor: args.panelColor, accent: args.accent, accent2: args.accent2, headingColor: args.headingColor, bodyColor: args.bodyColor, bgImageUrl: refOf(args.bgImageUrl), showcaseUrl: refOf(args.showcaseUrl), portfolioImagesJson: JSON.stringify(Object.fromEntries(Object.entries(args.portfolioImages).map(([k, v]) => [k, refOf(v)]))), paymentMethodsJson: JSON.stringify(payMethods), cryptoWalletsJson: JSON.stringify(wallets), verifiedOnly: args.verifiedOnly ? 1 : 0 }).where(eq(schema.creators.id, args.creatorId));
      await db.delete(schema.creatorCategories).where(eq(schema.creatorCategories.creatorId, args.creatorId));
      if (cats.length > 0) await db.insert(schema.creatorCategories).values(cats.map(category => ({ creatorId: args.creatorId, category })));
      return { ok: true as const, id: args.creatorId };
    },
  }),

  resetCreatorTheme: defineAction({
    description: "Resets a creator's profile customization to their default look. Requires a session token and only works on the signed-in account's OWN creator page.",
    request: z.object({ creatorId: z.string() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAccount(ctx);
      const db = ctx.db;
      const rows = me.creatorId === args.creatorId ? await db.select().from(schema.creators).where(eq(schema.creators.id, args.creatorId)) : [];
      const c = rows[0]; if (!c) throw new Error("That page couldn't be found.");
      const defaults: Record<string, { accent: string; bgColor: string; accent2: string; headingColor: string; bodyColor: string }> = {
        velvetine: { accent: "#e05260", bgColor: "#fff5f5", accent2: "#f9a8d4", headingColor: "#7f1d2d", bodyColor: "#57534e" },
        mothlight: { accent: "#2ec4b6", bgColor: "#f0fdfa", accent2: "#7dd3fc", headingColor: "#134e4a", bodyColor: "#475569" },
        goldleaf: { accent: "#9b7ed9", bgColor: "#faf5ff", accent2: "#facc15", headingColor: "#4c1d95", bodyColor: "#57534e" },
      };
      const d = defaults[c.id] ?? { accent: c.accent, bgColor: "#fffef9", accent2: "#facc15", headingColor: "#334155", bodyColor: "#475569" };
      await db.update(schema.creators).set({ pfpUrl: "", bannerUrl: "", bgImageUrl: "", showcaseUrl: "", portfolioImagesJson: "{}", panelColor: "#ffffff", ...d }).where(eq(schema.creators.id, args.creatorId));
      return { ok: true as const, id: args.creatorId };
    },
  }),

  signUp: defineAction({
    description: "Creates a prototype account (buyer or creator). Creator sign-ups also create a starter creator page at a unique slug. Returns the account payload + CSRF token; the session itself rides an HttpOnly cookie.",
    request: z.object({ displayName: z.string().min(1).max(60), username: z.string().min(3).max(24), email: z.string().min(3).max(120), password: z.string().min(1).max(200), accountType: z.enum(["buyer", "creator"]), shopName: z.string().max(60).default(""), over18: z.literal(true), inviteCode: z.string().max(40).default(""), fingerprint: z.string().max(128).default("") }),
    response: authResponse,
    async handler(ctx, args): Promise<z.infer<typeof authResponse>> {
      const db = ctx.db;
      const displayName = args.displayName.trim();
      const username = args.username.trim();
      const email = args.email.trim();
      if (!displayName) throw new Error("Please add a display name.");
      if (!/^[a-zA-Z0-9_.-]+$/.test(username)) throw new Error("Usernames can only use letters, numbers, dots, dashes and underscores.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That email doesn't look quite right — check it and try again.");
      /* NIST SP 800-63B-4 password policy: at least 15 characters, up to
         200, anything printable goes, NO composition rules — length and a
         common-password screen do the work instead. */
      if (args.password.length < 15) throw new Error("Passwords need at least 15 characters — a short sentence makes a great one.");
      const COMMON_PASSWORDS = new Set(["passwordpassword", "password1234567", "123456789012345", "1234567890123456", "qwertyqwertyqwe", "qwertyuiop12345", "letmeinletmein1", "iloveyouiloveyou", "thisismypassword", "correcthorsebatterystaple", "adminadminadmin", "welcome12345678", "changemechangeme", "footballfootball", "baseballbaseball", "dragonballdragon", "supermansuperman", "batmanbatmanbatm", "trustno1trustno1", "sunshinesunshine", "princessprincess", "charliecharlie1", "michaelmichael1", "shadowshadow123"]);
      if (COMMON_PASSWORDS.has(args.password.toLowerCase()) || /^(\S)\1+$/.test(args.password)) throw new Error("That password is too well-known — pick something less guessable.");
      /* Closed test: sign-up REQUIRES a valid invite code — one generic
         error for missing/unknown/disabled/used-up codes, so codes can't
         be probed. The single exception is the hardcoded owner email:
         the owner must be able to create the very first account (and the
         first invite codes) — a bootstrap door that exists for exactly
         one address, checked server-side. */
      let inviteRow: typeof schema.inviteCodes.$inferSelect | null = null;
      if (email.toLowerCase() !== ownerEmail()) {
        const codeNorm = args.inviteCode.trim().toUpperCase();
        if (!codeNorm) throw new Error("That invite code isn't valid.");
        const invRows = await db.select().from(schema.inviteCodes).where(eq(schema.inviteCodes.code, codeNorm));
        const inv = invRows[0];
        if (!inv || inv.disabled === 1 || inv.usesCount >= inv.maxUses) throw new Error("That invite code isn't valid.");
        inviteRow = inv;
      }
      const all = await db.select().from(schema.accounts);
      if (all.some(a => a.email.toLowerCase() === email.toLowerCase())) throw new Error("That email already has an account — try logging in instead.");
      if (all.some(a => a.username.toLowerCase() === username.toLowerCase())) throw new Error("That username is taken — try a different one.");
      const id = uid("acct");
      let creatorId: string | null = null;
      let creatorValues: typeof schema.creators.$inferInsert | null = null;
      if (args.accountType === "creator") {
        const shopName = args.shopName.trim() || displayName;
        const existing = await db.select().from(schema.creators);
        const taken = new Set<string>();
        existing.forEach(c => { taken.add(c.id.toLowerCase()); taken.add(slugifyServer(c.name)); });
        const base = slugifyServer(shopName) || "creator";
        let slug = base; let n = 2;
        while (taken.has(slug)) { slug = `${base}-${n}`; n += 1; }
        creatorId = slug;
        creatorValues = {
          id: slug, name: shopName, handle: `@${username}`, tagline: "A brand-new little shop — watch this space!", accent: "#f472b6",
          bio: `Hi, I'm ${displayName}! This is my new commission page — I'm still setting up, so say hello and tell me what you'd love to have made.`,
          status: "open", turnaround: "Standard: within 7 days · Extended: weekly blocks",
          pricesJson: JSON.stringify([{ label: "Starter commission", price: 50 }]),
          willDoJson: JSON.stringify(["Original characters", "Tell me your idea — let's chat!"]),
          wontDoJson: JSON.stringify(["Anything on my future no-list — ask first if unsure"]),
          portfolioJson: JSON.stringify([{ title: "First Piece", kind: "Placeholder", hue: 320 }, { title: "Coming Soon", kind: "Placeholder", hue: 200 }, { title: "Watch This Space", kind: "Placeholder", hue: 45 }, { title: "New Work", kind: "Placeholder", hue: 150 }]),
          bgColor: "#fffef9", panelColor: "#ffffff", accent2: "#facc15", headingColor: "#334155", bodyColor: "#475569",
        };
      }
      /* Invite consumption is a CONDITIONAL SQL increment — the use is
         spent only if the row still has uses left at write time, so two
         sign-ups racing for the last use cannot both pass (a stale read
         can never resurrect a spent code). If the account insert then
         fails, the use is handed back. */
      if (inviteRow) {
        const consumed = await db.update(schema.inviteCodes)
          .set({ usesCount: sql`${schema.inviteCodes.usesCount} + 1` })
          .where(and(eq(schema.inviteCodes.id, inviteRow.id), eq(schema.inviteCodes.disabled, 0), sql`${schema.inviteCodes.usesCount} < ${schema.inviteCodes.maxUses}`))
          .returning({ id: schema.inviteCodes.id });
        if (consumed.length === 0) throw new Error("That invite code isn't valid.");
      }
      /* Creator page (if any) + account land in one batch. New accounts
         start with 500 test credits (play money, granted free — there is
         no buy-in anywhere in this build). The owner account is born
         admin. */
      const passwordHash = await authHashPassword(args.password);
      /* Tripwire (NOT a wall): if this device's fingerprint matches a
         BANNED account's fingerprint, the new account is silently flagged
         for the owner in Admin. Fingerprints are spoofable and shared
         devices exist, so nothing automatic ever happens from a match. */
      const fp = args.fingerprint.trim();
      let banEvasionFlag = 0;
      if (fp) {
        const bannedWithFp = all.filter(a => a.isBanned === 1 && a.deviceFingerprint && a.deviceFingerprint === fp);
        if (bannedWithFp.length > 0) banEvasionFlag = 1;
      }
      /* Creator page (if any) + account land inside the router's
         transaction, so a failure anywhere rolls the invite use back
         with everything else — no manual give-back needed. A duplicate
         email/username that slips past the pre-check above surfaces via
         the lower() unique indexes and is translated to the friendly
         message. */
      try {
        if (creatorValues) await db.insert(schema.creators).values(creatorValues);
        /* v2: new accounts start at 0 standing — standing is earned only,
           never granted at signup, never purchasable. */
        await db.insert(schema.accounts).values({ id, displayName, username, email, passwordHash, accountType: args.accountType, creatorId, credits: 0, lifetimeEarned: 0, deviceFingerprint: fp, banEvasionFlag, isAdmin: email.toLowerCase() === ownerEmail() ? 1 : 0, role: email.toLowerCase() === ownerEmail() ? "dev" : "member" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("accounts_email_lower_idx")) throw new Error("That email already has an account — try logging in instead.");
        if (msg.includes("accounts_username_lower_idx")) throw new Error("That username is taken — try a different one.");
        throw e;
      }
      const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
      const acct = rows[0]; if (!acct) throw new Error("Account could not be created — please try again.");
      await startSession(ctx, id);
      return { csrfToken: ctx.csrfToken!, account: await accountPayload(ctx, acct) };
    },
  }),

  logIn: defineAction({
    description: "Logs in with email + password and returns a fresh persistent session token.",
    request: z.object({ email: z.string().min(1).max(120), password: z.string().min(1).max(200) }),
    response: authResponse,
    async handler(ctx, args): Promise<z.infer<typeof authResponse>> {
      const db = ctx.db;
      const emailKey = args.email.trim().toLowerCase();
      /* Throttle per account: 5 failed attempts inside 15 minutes pauses
         further tries until the oldest failures age out of the window —
         a progressive slow-down, not a permanent lockout. (Per-IP
         throttling isn't possible here: the runtime exposes no client IP
         to actions.) Failures live in the DB so the limit holds across
         server restarts; a successful login clears the slate. */
      const since = Date.now() - 15 * 60 * 1000;
      const attempts = await db.select().from(schema.loginAttempts).where(eq(schema.loginAttempts.email, emailKey));
      if (attempts.filter(a => a.createdAt.getTime() >= since).length >= 5) throw new Error("Lots of failed tries lately — the login gate is taking a short breather. Try again in a few minutes.");
      const all = await db.select().from(schema.accounts);
      const acct = all.find(a => a.email.toLowerCase() === emailKey);
      if (acct && acct.isBanned === 1 && (await authVerifyPassword(args.password, acct.passwordHash))) throw new Error("This account has been suspended — if you think that's a mistake, contact the site owner.");
      if (!acct || !(await authVerifyPassword(args.password, acct.passwordHash))) {
        await db.insert(schema.loginAttempts).values({ email: emailKey });
        throw new Error("That email and password don't match.");
      }
      await db.delete(schema.loginAttempts).where(eq(schema.loginAttempts.email, emailKey));
      await startSession(ctx, acct.id);
      return { csrfToken: ctx.csrfToken!, account: await accountPayload(ctx, acct) };
    },
  }),

  logOut: defineAction({
    description: "Ends the current session (deletes its row server-side and clears the cookie).",
    request: z.object({}),
    response: okResponse,
    async handler(ctx): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      if (ctx.sessionHash) await db.delete(schema.sessions).where(eq(schema.sessions.token, ctx.sessionHash));
      ctx.clearSessionCookie = true;
      return { ok: true as const };
    },
  }),

  listPosts: defineAction({
    description: "Public offer feed: newest posts first (max 50), optionally filtered in SQL by one taxonomy category via the post_categories join table. Public fields only.",
    request: z.object({ category: z.string().max(60).default("") }),
    response: feedResponse,
    async handler(ctx, args): Promise<z.infer<typeof feedResponse>> {
      const db = ctx.db;
      const cat = args.category.trim();
      if (cat && !CATEGORY_SET.has(cat)) throw new Error(`Unknown category: ${cat}`);
      /* Category filtering happens in SQL: the feed only ever loads posts
         tagged with the selected category, never a client-side trim. */
      const rows = cat
        ? await db.select().from(schema.posts)
            .where(inArray(schema.posts.id, db.select({ pid: schema.postCategories.postId }).from(schema.postCategories).where(eq(schema.postCategories.category, cat))))
            .orderBy(desc(schema.posts.createdAt)).limit(50)
        : await db.select().from(schema.posts).orderBy(desc(schema.posts.createdAt)).limit(50);
      const posts = await loadPosts(ctx, rows);
      return { posts, total: posts.length };
    },
  }),

  createPost: defineAction({
    description: "Creates an offer post. The posting creator is derived from the session (the account's own creator page) — a client-supplied creator id is never accepted. Creator accounts only.",
    request: z.object({ title: z.string().min(1).max(80), body: z.string().min(1).max(600), priceNote: z.string().max(60).default(""), imageUrl: z.string().max(900000).default(""), videoUrl: z.string().max(MAX_VIDEO_DATAURL + 100).default(""), categories: z.array(z.string().max(60)).max(3).default([]) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAccount(ctx);
      /* Buyers and creator-less accounts can't post offers — the creator is
         whoever the session says owns a page, full stop. */
      if (!me.creatorId) throw new Error("Only creator accounts can post offers — this account doesn't have a creator page.");
      const title = args.title.trim();
      const body = args.body.trim();
      if (!title) throw new Error("Give your post a title.");
      if (!body) throw new Error("Tell buyers what you're offering.");
      const priceNote = args.priceNote.trim();
      checkImageValue(args.imageUrl, "Post image");
      checkVideoValue(args.videoUrl, "Post video");
      await assertAsset(ctx, args.imageUrl, ["post_image"], me.id, "Post image");
      await assertAsset(ctx, args.videoUrl, ["post_video"], me.id, "Post video");
      const cats = [...new Set(args.categories)];
      for (const c of cats) if (!CATEGORY_SET.has(c)) throw new Error(`Unknown category: ${c} — pick from the category list.`);
      const db = ctx.db;
      const id = uid("post");
      await db.insert(schema.posts).values({ id, creatorId: me.creatorId, title, body, priceNote, imageUrl: refOf(args.imageUrl), videoUrl: refOf(args.videoUrl) });
      if (cats.length > 0) await db.insert(schema.postCategories).values(cats.map(category => ({ postId: id, category })));
      return { ok: true as const, id };
    },
  }),

  deletePost: defineAction({
    description: "Deletes one of the signed-in creator's own offer posts. A post owned by someone else answers exactly like a post that doesn't exist.",
    request: z.object({ postId: z.string() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAccount(ctx);
      const db = ctx.db;
      /* Ownership-scoped lookup: not yours = not found, indistinguishable. */
      const rows = me.creatorId ? await db.select().from(schema.posts).where(and(eq(schema.posts.id, args.postId), eq(schema.posts.creatorId, me.creatorId))) : [];
      if (!rows[0]) throw new Error("That post couldn't be found.");
      await db.delete(schema.postCategories).where(eq(schema.postCategories.postId, args.postId));
      await db.delete(schema.posts).where(eq(schema.posts.id, args.postId));
      return { ok: true as const, id: args.postId };
    },
  }),

  listMyPosts: defineAction({
    description: "Lists the signed-in creator's own offer posts, newest first (for the account page). Buyer accounts get an empty list.",
    request: z.object({}),
    response: feedResponse,
    async handler(ctx, args): Promise<z.infer<typeof feedResponse>> {
      const me = await requireAccount(ctx);
      if (!me.creatorId) return { posts: [], total: 0 };
      const db = ctx.db;
      const rows = await db.select().from(schema.posts).where(eq(schema.posts.creatorId, me.creatorId)).orderBy(desc(schema.posts.createdAt)).limit(50);
      const posts = await loadPosts(ctx, rows);
      return { posts, total: posts.length };
    },
  }),

  createReport: defineAction({
    description: "Files a report on a post, creator page, vault item or portfolio item. Open to any visitor; a signed-in session attaches the reporter, otherwise the report files anonymously.",
    request: z.object({ targetType: z.enum(["post", "creator", "vault_item", "portfolio"]), targetId: z.string().min(1).max(120), itemTitle: z.string().max(160).default(""), reason: z.enum(REPORT_REASONS), detail: z.string().max(500).default("") }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      /* The reported thing must exist (portfolio items live inside the
         creator row — the title must be one of theirs). */
      let exists = false;
      if (args.targetType === "post") exists = (await db.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.id, args.targetId))).length > 0;
      else if (args.targetType === "vault_item") exists = (await db.select({ id: schema.auctionItems.id }).from(schema.auctionItems).where(eq(schema.auctionItems.id, args.targetId))).length > 0;
      else { const rows = await db.select().from(schema.creators).where(eq(schema.creators.id, args.targetId)); const c = rows[0]; exists = !!c && (args.targetType === "creator" || parseJson<{ title: string }[]>(c.portfolioJson, []).some(p => p.title === args.itemTitle)); }
      if (!exists) throw new Error("That content couldn't be found.");
      const reporterId: string | null = ctx.account?.id ?? null;
      const id = uid("rep");
      await db.insert(schema.reports).values({ id, reporterAccountId: reporterId, targetType: args.targetType, targetId: args.targetId, itemTitle: args.itemTitle, reason: args.reason, detail: args.detail.trim(), status: "open" });
      return { ok: true as const, id };
    },
  }),

  adminGetState: defineAction({
    description: "Admin-only bundle for the Owner controls page: invite codes, accounts, the reports queue, the quarantine list and the moderation log. Non-admins get the same 'couldn't be found' as a missing page.",
    request: z.object({}),
    response: adminStateResponse,
    async handler(ctx, args): Promise<z.infer<typeof adminStateResponse>> {
      const me = await requireStaff(ctx);
      const callerIsDev = roleOf(me) === "dev";
      const db = ctx.db;
      const invites = await db.select().from(schema.inviteCodes).orderBy(desc(schema.inviteCodes.createdAt));
      const accts = await db.select().from(schema.accounts).orderBy(asc(schema.accounts.createdAt));
      const reps = await db.select().from(schema.reports).orderBy(desc(schema.reports.createdAt)).limit(100);
      const creatorsAll = await db.select().from(schema.creators);
      const creatorById = new Map(creatorsAll.map(c => [c.id, c]));
      const postsAll = await db.select().from(schema.posts);
      const itemsAll = await db.select().from(schema.auctionItems);
      const reportLabel = (r: typeof schema.reports.$inferSelect): { label: string; href: string } => {
        if (r.targetType === "post") { const p = postsAll.find(x => x.id === r.targetId); return { label: p ? `Post: “${p.title}” by ${creatorById.get(p.creatorId)?.name ?? p.creatorId}` : "Post (deleted)", href: "/" }; }
        if (r.targetType === "vault_item") { const it = itemsAll.find(x => x.id === r.targetId); return { label: it ? `Vault item: “${it.title}” by ${it.creatorName}` : "Vault item (deleted)", href: "/vault" }; }
        const c = creatorById.get(r.targetId);
        const label = r.targetType === "portfolio" ? `Portfolio item: “${r.itemTitle}” on ${c?.name ?? r.targetId}` : `Creator page: ${c?.name ?? r.targetId}`;
        return { label, href: c ? `/creators/${slugifyServer(c.name) || c.id}` : "/search" };
      };
      const quarantine: z.infer<typeof quarantineOut>[] = [];
      for (const p of postsAll) if (p.quarantined === 1) quarantine.push({ targetType: "post", targetId: p.id, itemTitle: "", title: p.title, ownerLabel: creatorById.get(p.creatorId)?.name ?? p.creatorId, note: p.quarantineNote ?? "", quarantinedAt: p.quarantinedAt ? p.quarantinedAt.toISOString() : "" });
      for (const it of itemsAll) if (it.quarantined === 1) quarantine.push({ targetType: "vault_item", targetId: it.id, itemTitle: "", title: it.title, ownerLabel: it.creatorName, note: it.quarantineNote ?? "", quarantinedAt: it.quarantinedAt ? it.quarantinedAt.toISOString() : "" });
      for (const c of creatorsAll) {
        if (c.quarantined === 1) quarantine.push({ targetType: "creator", targetId: c.id, itemTitle: "", title: `${c.name} — whole page`, ownerLabel: c.handle, note: c.quarantineNote ?? "", quarantinedAt: c.quarantinedAt ? c.quarantinedAt.toISOString() : "" });
        for (const t of parseJson<string[]>(c.portfolioQuarantineJson ?? "[]", [])) quarantine.push({ targetType: "portfolio", targetId: c.id, itemTitle: t, title: t, ownerLabel: c.name, note: "", quarantinedAt: "" });
      }
      const logRows = await db.select().from(schema.moderationLog).orderBy(desc(schema.moderationLog.id)).limit(100);
      const strikeRowsAll = await db.select().from(schema.strikes);
      const strikeCount = new Map<string, number>();
      for (const st of strikeRowsAll) strikeCount.set(st.accountId, (strikeCount.get(st.accountId) ?? 0) + 1);
      const commRowsAll = await db.select().from(schema.commissions);
      const ghostJobs = commRowsAll.filter(c => c.status === "unlocked" && c.unlockedAt).map(c => { const unlockMs = c.unlockedAt!.getTime(); const daysUntilGhost = Math.max(0, Math.ceil((unlockMs + 7 * 24 * 3600 * 1000 - Date.now()) / (24 * 3600 * 1000))); return { id: c.id, title: c.title, unlockedAt: c.unlockedAt!.toISOString(), downloadCount: c.downloadCount ?? 0, ghostReleased: c.ghostReleased === 1, daysUntilGhost }; });
      /* Trust Pool queue: v2 jobs a buyer walked away from (deadline
         missed after payment milestones) or the artist escalated — the
         jobs where a cover decision belongs to the dev. `covered` reads
         the standing-events trail so a job can't be covered twice. */
      const coverRows = await db.select().from(schema.standingEvents).where(eq(schema.standingEvents.kind, "trust_pool_cover"));
      const coveredJobIds = new Set(coverRows.map(r => r.commissionId));
      const refundJobs = commRowsAll.filter(c => c.v2 === 1 && !!c.buyerAccountId && (c.status === "walked_away" || c.escalated === 1)).map(c => ({ id: c.id, title: c.title, status: c.status, price: c.price, depositAmount: c.depositAmount ?? 0, buyerName: c.buyerName, creatorName: creatorById.get(c.creatorId)?.name ?? c.creatorId, escalated: c.escalated === 1, covered: coveredJobIds.has(c.id) }));
      return {
        invites: callerIsDev ? invites.map(i => ({ id: i.id, code: i.code, maxUses: i.maxUses, usesCount: i.usesCount, disabled: i.disabled === 1, createdAt: i.createdAt.toISOString() })) : [],
        accounts: accts.map(a => { const lv = levelOf(a.lifetimeEarned ?? 0); return { id: a.id, displayName: a.displayName, username: a.username, email: a.email, accountType: a.accountType, creatorId: a.creatorId ?? null, isBanned: a.isBanned === 1, isOwner: a.email.trim().toLowerCase() === ownerEmail(), role: roleOf(a), refundDebt: a.refundDebt ?? 0, credits: a.credits ?? 0, createdAt: a.createdAt.toISOString(), verified: a.verified === 1, lifetimeEarned: a.lifetimeEarned ?? 0, level: lv.level, levelName: lv.name, strikes: strikeCount.get(a.id) ?? 0, banEvasionFlag: a.banEvasionFlag === 1 }; }),
        reports: reps.map(r => { const l = reportLabel(r); return { id: r.id, targetType: r.targetType, targetId: r.targetId, itemTitle: r.itemTitle, targetLabel: l.label, targetHref: l.href, reason: r.reason, detail: r.detail, status: r.status, createdAt: r.createdAt.toISOString() }; }),
        quarantine,
        log: logRows.map(l => ({ id: l.id, actorLabel: l.actorLabel, action: l.action, targetType: l.targetType, targetId: l.targetId, note: l.note, createdAt: l.createdAt.toISOString() })),
        ghostJobs,
        refundJobs,
      };
    },
  }),

  adminGenerateInvite: defineAction({
    description: "Admin-only: generates a new unguessable invite code with a chosen number of uses.",
    request: z.object({ maxUses: z.number().int().min(1).max(100) }),
    response: z.object({ ok: z.literal(true), id: z.string(), code: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; id: string; code: string }> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const code = newInviteCode();
      const id = uid("inv");
      await db.insert(schema.inviteCodes).values({ id, code, maxUses: args.maxUses, usesCount: 0, createdBy: me.id, disabled: 0 });
      await addModLog(ctx, me, "invite_generated", "invite_code", id, `Code ${code} · ${args.maxUses} use(s)`);
      return { ok: true as const, id, code };
    },
  }),

  adminDisableInvite: defineAction({
    description: "Admin-only: disables an invite code so it can no longer be used to sign up.",
    request: z.object({ inviteId: z.string() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.inviteCodes).where(eq(schema.inviteCodes.id, args.inviteId));
      const inv = rows[0]; if (!inv) throw new Error("That invite code couldn't be found.");
      await db.update(schema.inviteCodes).set({ disabled: 1 }).where(eq(schema.inviteCodes.id, args.inviteId));
      await addModLog(ctx, me, "invite_disabled", "invite_code", args.inviteId, `Code ${inv.code}`);
      return { ok: true as const, id: args.inviteId };
    },
  }),

  adminQuarantine: defineAction({
    description: "Admin-only: quarantines a post, vault item, creator page or portfolio item — hidden from all public surfaces immediately, original data and media preserved untouched as evidence. Optionally resolves a linked report.",
    request: z.object({ targetType: z.enum(["post", "creator", "vault_item", "portfolio"]), targetId: z.string(), itemTitle: z.string().max(160).default(""), note: z.string().max(500).default(""), reportId: z.string().default("") }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireStaff(ctx);
      const db = ctx.db;
      const now = new Date();
      const note = args.note.trim();
      if (args.targetType === "post") {
        const rows = await db.select().from(schema.posts).where(eq(schema.posts.id, args.targetId));
        if (!rows[0]) throw new Error("That post couldn't be found.");
        /* ONLY the quarantine flag/note/timestamp change — title, body and
           media payloads are never touched, so the original survives
           byte-identical for evidence. */
        await db.update(schema.posts).set({ quarantined: 1, quarantinedAt: now, quarantineNote: note }).where(eq(schema.posts.id, args.targetId));
      } else if (args.targetType === "vault_item") {
        const rows = await db.select().from(schema.auctionItems).where(eq(schema.auctionItems.id, args.targetId));
        if (!rows[0]) throw new Error("That vault item couldn't be found.");
        await db.update(schema.auctionItems).set({ quarantined: 1, quarantinedAt: now, quarantineNote: note }).where(eq(schema.auctionItems.id, args.targetId));
      } else if (args.targetType === "creator") {
        const rows = await db.select().from(schema.creators).where(eq(schema.creators.id, args.targetId));
        if (!rows[0]) throw new Error("That page couldn't be found.");
        await db.update(schema.creators).set({ quarantined: 1, quarantinedAt: now, quarantineNote: note }).where(eq(schema.creators.id, args.targetId));
      } else {
        const rows = await db.select().from(schema.creators).where(eq(schema.creators.id, args.targetId));
        const c = rows[0]; if (!c) throw new Error("That page couldn't be found.");
        if (!parseJson<{ title: string }[]>(c.portfolioJson, []).some(p => p.title === args.itemTitle)) throw new Error("That portfolio item couldn't be found.");
        const list = parseJson<string[]>(c.portfolioQuarantineJson ?? "[]", []);
        if (!list.includes(args.itemTitle)) await db.update(schema.creators).set({ portfolioQuarantineJson: JSON.stringify([...list, args.itemTitle]) }).where(eq(schema.creators.id, args.targetId));
      }
      await addModLog(ctx, me, "quarantine", args.targetType, args.targetType === "portfolio" ? `${args.targetId}::${args.itemTitle}` : args.targetId, note);
      if (args.reportId) await db.update(schema.reports).set({ status: "actioned" }).where(eq(schema.reports.id, args.reportId));
      return { ok: true as const, id: args.targetId };
    },
  }),

  adminRestore: defineAction({
    description: "Admin-only: restores a quarantined item to public view (for mistakes).",
    request: z.object({ targetType: z.enum(["post", "creator", "vault_item", "portfolio"]), targetId: z.string(), itemTitle: z.string().max(160).default("") }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireStaff(ctx);
      const db = ctx.db;
      if (args.targetType === "post") await db.update(schema.posts).set({ quarantined: 0, quarantinedAt: null, quarantineNote: "" }).where(eq(schema.posts.id, args.targetId));
      else if (args.targetType === "vault_item") await db.update(schema.auctionItems).set({ quarantined: 0, quarantinedAt: null, quarantineNote: "" }).where(eq(schema.auctionItems.id, args.targetId));
      else if (args.targetType === "creator") await db.update(schema.creators).set({ quarantined: 0, quarantinedAt: null, quarantineNote: "" }).where(eq(schema.creators.id, args.targetId));
      else {
        const rows = await db.select().from(schema.creators).where(eq(schema.creators.id, args.targetId));
        const c = rows[0]; if (!c) throw new Error("That page couldn't be found.");
        const list = parseJson<string[]>(c.portfolioQuarantineJson ?? "[]", []).filter(t => t !== args.itemTitle);
        await db.update(schema.creators).set({ portfolioQuarantineJson: JSON.stringify(list) }).where(eq(schema.creators.id, args.targetId));
      }
      await addModLog(ctx, me, "restore", args.targetType, args.targetType === "portfolio" ? `${args.targetId}::${args.itemTitle}` : args.targetId, "");
      return { ok: true as const, id: args.targetId };
    },
  }),

  adminDelete: defineAction({
    description: "Admin-only: PERMANENTLY deletes a post, vault item, creator page or portfolio item. Irreversible — quarantine first when the content might be evidence. Optionally resolves a linked report.",
    request: z.object({ targetType: z.enum(["post", "creator", "vault_item", "portfolio"]), targetId: z.string(), itemTitle: z.string().max(160).default(""), reportId: z.string().default("") }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireStaff(ctx);
      const db = ctx.db;
      let label = args.targetId;
      if (args.targetType === "post") {
        const rows = await db.select().from(schema.posts).where(eq(schema.posts.id, args.targetId));
        if (!rows[0]) throw new Error("That post couldn't be found.");
        label = rows[0].title;
        await db.delete(schema.postCategories).where(eq(schema.postCategories.postId, args.targetId));
        await db.delete(schema.posts).where(eq(schema.posts.id, args.targetId));
      } else if (args.targetType === "vault_item") {
        const rows = await db.select().from(schema.auctionItems).where(eq(schema.auctionItems.id, args.targetId));
        if (!rows[0]) throw new Error("That vault item couldn't be found.");
        label = rows[0].title;
        await db.delete(schema.auctionItems).where(eq(schema.auctionItems.id, args.targetId));
      } else if (args.targetType === "creator") {
        const rows = await db.select().from(schema.creators).where(eq(schema.creators.id, args.targetId));
        if (!rows[0]) throw new Error("That page couldn't be found.");
        label = rows[0].name;
        const theirPosts = await db.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.creatorId, args.targetId));
        for (const p of theirPosts) await db.delete(schema.postCategories).where(eq(schema.postCategories.postId, p.id));
        await db.delete(schema.posts).where(eq(schema.posts.creatorId, args.targetId));
        await db.delete(schema.creatorCategories).where(eq(schema.creatorCategories.creatorId, args.targetId));
        await db.delete(schema.creators).where(eq(schema.creators.id, args.targetId));
      } else {
        const rows = await db.select().from(schema.creators).where(eq(schema.creators.id, args.targetId));
        const c = rows[0]; if (!c) throw new Error("That page couldn't be found.");
        label = args.itemTitle;
        const pf = parseJson<{ title: string; kind: string; hue: number }[]>(c.portfolioJson, []).filter(p => p.title !== args.itemTitle);
        const imgs = parseJson<Record<string, string>>(c.portfolioImagesJson ?? "{}", {}); delete imgs[args.itemTitle];
        const qList = parseJson<string[]>(c.portfolioQuarantineJson ?? "[]", []).filter(t => t !== args.itemTitle);
        await db.update(schema.creators).set({ portfolioJson: JSON.stringify(pf), portfolioImagesJson: JSON.stringify(imgs), portfolioQuarantineJson: JSON.stringify(qList) }).where(eq(schema.creators.id, args.targetId));
      }
      await addModLog(ctx, me, "delete", args.targetType, args.targetType === "portfolio" ? `${args.targetId}::${args.itemTitle}` : args.targetId, `Permanently deleted: ${label}`);
      if (args.reportId) await db.update(schema.reports).set({ status: "actioned" }).where(eq(schema.reports.id, args.reportId));
      return { ok: true as const, id: args.targetId };
    },
  }),

  adminSetBan: defineAction({
    description: "Admin-only: bans or unbans an account. Banning revokes all sessions, blocks future logins, and hides the account's creator page and posts. The owner account can never be banned.",
    request: z.object({ accountId: z.string(), banned: z.boolean() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireStaff(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, args.accountId));
      const target = rows[0]; if (!target) throw new Error("That account couldn't be found.");
      if (args.banned && (target.email.trim().toLowerCase() === ownerEmail() || target.id === me.id)) throw new Error("The owner account can't be banned.");
      if (args.banned) {
        /* v2: a ban burns the account's standing — balance zeroed and
           lifetime earned reset, so the level and its privileges die with
           the account. The burn is part of the moderation record. */
        await db.update(schema.accounts).set({ isBanned: 1, credits: 0, lifetimeEarned: 0 }).where(eq(schema.accounts.id, args.accountId));
        await db.delete(schema.sessions).where(eq(schema.sessions.accountId, args.accountId));
        await addModLog(ctx, me, "ban", "account", args.accountId, `@${target.username} banned — standing burned (${target.credits ?? 0} balance and ${target.lifetimeEarned ?? 0} lifetime earned zeroed)`);
      } else {
        await db.update(schema.accounts).set({ isBanned: 0 }).where(eq(schema.accounts.id, args.accountId));
        await addModLog(ctx, me, "unban", "account", args.accountId, `@${target.username}`);
      }
      return { ok: true as const, id: args.accountId };
    },
  }),

  adminGrantCredits: defineAction({
    description: "Admin-only: grants extra test credits (play money, no cash value) to an account — the tester top-up. Logged in the moderation log.",
    request: z.object({ accountId: z.string(), amount: z.number().int().min(1).max(100000) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, args.accountId));
      const target = rows[0]; if (!target) throw new Error("That account couldn't be found.");
      await db.update(schema.accounts).set({ credits: (target.credits ?? 0) + args.amount }).where(eq(schema.accounts.id, args.accountId));
      await addModLog(ctx, me, "grant_credits", "account", args.accountId, `+${args.amount} test credits to @${target.username}`);
      return { ok: true as const, id: args.accountId };
    },
  }),

  adminDismissReport: defineAction({
    description: "Admin-only: dismisses a report in the queue (no action taken). Recorded in the moderation log.",
    request: z.object({ reportId: z.string() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireStaff(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.reports).where(eq(schema.reports.id, args.reportId));
      const rep = rows[0]; if (!rep) throw new Error("That report couldn't be found.");
      await db.update(schema.reports).set({ status: "dismissed" }).where(eq(schema.reports.id, args.reportId));
      await addModLog(ctx, me, "report_dismissed", rep.targetType, rep.targetId, `Report: ${rep.reason}`);
      return { ok: true as const, id: args.reportId };
    },
  }),

  milestoneAct: defineAction({
    description: "v2 milestone flow for real-account jobs: quote (level-capped), deposit confirmation, sketch gate, vault delivery, balance confirmation (unlock), walk-away, escalation and vault withdrawal. Party-checked server-side whenever the job is linked to real accounts; the platform records confirmations, never money.",
    request: z.object({ id: z.string(), action: z.enum(["quote", "confirmDeposit", "submitDepositTx", "checkDepositTx", "submitSketch", "approveSketch", "requestRevision", "deemedApprove", "deliverVault", "confirmBalance", "submitBalanceTx", "checkBalanceTx", "walkAway", "escalate", "withdrawVault", "salvageVault"]), quotePrice: z.number().int().positive().optional(), depositAmount: z.number().int().min(0).optional(), sketchImageUrl: z.string().max(900000).default(""), vaultFileUrl: z.string().max(2900000).default(""), vaultPreviewUrl: z.string().max(900000).default(""), vaultFileName: z.string().max(160).default(""), txid: z.string().max(128).default("") }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db;
      const rows = await db.select().from(schema.commissions).where(eq(schema.commissions.id, args.id));
      const c = rows[0]; if (!c) throw new Error("Commission not found");
      if (c.v2 !== 1) throw new Error("That job runs on the earlier demo flow — milestone actions apply to v2 jobs from signed-in accounts.");
      const now = new Date();
      const deadline7 = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      const creatorAcct = (await db.select().from(schema.accounts).where(eq(schema.accounts.creatorId, c.creatorId)))[0] ?? null;
      const buyerAcct = c.buyerAccountId ? (await db.select().from(schema.accounts).where(eq(schema.accounts.id, c.buyerAccountId)))[0] ?? null : null;
      /* Party enforcement: when the relevant side is a real account, the
         caller must BE that account. When a side has no account (a sample
         shop), that side's controls stay open as demo controls — exactly
         how the legacy Jobs page behaves. */
      const party = async (side: "buyer" | "creator") => {
        const acct = side === "buyer" ? buyerAcct : creatorAcct;
        /* Plan §4.1.5: a side with NO account (a sample shop) is
           staff-only on the standalone build — anonymous milestone
           control of any job is off. */
        if (!acct) { requireStaff(ctx); return; }
        const me = requireAccount(ctx);
        if (me.id !== acct.id) throw new Error(side === "buyer" ? "Only the buyer of record can do that step." : "Only the job's artist can do that step.");
      };
      /* Steps with no single party of record (the transaction checker's
         check actions, deemed approval): when the job involves any real
         account, the caller must be a party of record or staff. Demo
         jobs with no real account on either side are staff-only. */
      const partyOrStaff = async () => {
        if (!buyerAcct && !creatorAcct) { requireStaff(ctx); return; }
        const me = requireAccount(ctx);
        if (roleOf(me) !== "member") return;
        if (buyerAcct && me.id === buyerAcct.id) return;
        if (creatorAcct && me.id === creatorAcct.id) return;
        throw new Error("Only the buyer or artist of record can do that step.");
      };
      let patch: Partial<typeof schema.commissions.$inferInsert> = { updatedAt: now };
      const net = cryptoNetworkOf(c);
      const netName = CRYPTO_NETWORKS.find(n => n.id === net)?.name ?? net;
      /* Shared transitions: the artist's manual confirmation (external
         rail) and the transaction checker's automatic confirmation
         (crypto rail) land in exactly the same states — only the label
         and the evidence note differ. */
      const applyDepositConfirmed = async (label: string, note: string) => {
        patch = { ...patch, status: "deposit_paid", depositConfirmed: 1, depositConfirmedAt: now, deadline: deadline7 };
        await addLedger(ctx, c.id, label, "Quoted", "Deposit Paid", c.depositAmount, note);
      };
      const applyUnlock = async (label: string, note: string) => {
        patch = { ...patch, status: "unlocked", balanceConfirmedAt: now, unlockedAt: now };
        await addLedger(ctx, c.id, label, "Delivered to Vault", "Unlocked", Math.max(0, c.price - c.depositAmount), note);
        if (creatorAcct) {
          await earnStanding(ctx, creatorAcct.id, c.id, "job_completed_artist", 40, "Job completed as artist");
          if (!(await hasStandingEvent(ctx, creatorAcct.id, "first_job"))) await earnStanding(ctx, creatorAcct.id, c.id, "first_job", 25, "First job completed");
        }
        if (buyerAcct) {
          await earnStanding(ctx, buyerAcct.id, c.id, "job_completed_buyer", 15, "Job completed as buyer");
          if (!(await hasStandingEvent(ctx, buyerAcct.id, "first_job"))) await earnStanding(ctx, buyerAcct.id, c.id, "first_job", 25, "First job completed");
        }
      };
      switch (args.action) {
        case "quote": {
          await party("creator");
          if (creatorAcct && (creatorAcct.refundDebt ?? 0) > 0) throw new Error(`You have an outstanding refund balance of $${creatorAcct.refundDebt} — quoting is paused until it's settled with the buyer or cleared by the owner. Refunds on direct payments are the seller's obligation.`);
          const price = args.quotePrice ?? c.budget;
          if (creatorAcct) {
            const lv = levelOf(creatorAcct.lifetimeEarned ?? 0);
            if (lv.cap > 0 && price > lv.cap) throw new Error(`That quote is above your level cap: Level ${lv.level} (${lv.name}) sellers can quote up to $${lv.cap}. Earn ${Math.max(0, (lv.nextMin ?? 0) - (creatorAcct.lifetimeEarned ?? 0))} more lifetime standing to reach the next level.`);
          }
          const deposit = Math.min(price, Math.max(0, args.depositAmount ?? Math.round(price / 2)));
          patch = { ...patch, status: "quoted", price, depositAmount: deposit, deadline: deadline7 };
          await addLedger(ctx, c.id, "Artist quoted the job", "Brief", "Quoted", price, `Total $${price} · deposit $${deposit} due before work starts · balance $${price - deposit} on delivery. Deadline: 7 days from deposit confirmation.`);
          break;
        }
        case "confirmDeposit": {
          await party("creator");
          if (c.status !== "quoted") throw new Error("The deposit can only be confirmed after a quote.");
          if (net) throw new Error(`This job pays by crypto (${netName}) — deposits on the crypto rail are confirmed by the transaction checker once the buyer submits the transaction ID, not by hand. That way neither side's word is the evidence; the transaction record is.`);
          await applyDepositConfirmed("Artist confirmed deposit received", "Paid buyer → artist directly on the artist's own payment account. The platform recorded the confirmation; it never touched the money. Work states unlock from here.");
          break;
        }
        case "submitDepositTx": {
          await party("buyer");
          if (!net) throw new Error("This job pays through the artist's external payment links — there's no crypto transaction to submit.");
          if (c.status !== "quoted") throw new Error("The deposit transaction is submitted after the quote, before work starts.");
          if (c.depositTxConfirmed === 1) throw new Error("The deposit is already confirmed for this job.");
          checkTxid(net, args.txid);
          patch = { ...patch, depositTx: args.txid.trim() };
          await addLedger(ctx, c.id, "Buyer submitted the deposit transaction", "Quoted", "Quoted", c.depositAmount, `Transaction ID ${args.txid.trim()} on ${netName}, sent buyer → artist wallet-to-wallet. The buyer sent it themselves from their own wallet; the platform never buys, holds or forwards crypto. The transaction checker verifies it next.`);
          break;
        }
        case "checkDepositTx": {
          await partyOrStaff();
          if (!net) throw new Error("This job doesn't pay by crypto — the artist confirms external payments by hand.");
          if (c.status !== "quoted") throw new Error("The deposit can only be checked while the job is at the quote stage.");
          if (!c.depositTx) throw new Error("No deposit transaction has been submitted yet — the buyer pastes the transaction ID from their wallet first.");
          if (c.depositTxConfirmed === 1) throw new Error("The deposit is already confirmed for this job.");
          patch = { ...patch, depositTxConfirmed: 1 };
          await applyDepositConfirmed("Transaction checker confirmed the deposit — step released automatically", `Checker result for transaction ${c.depositTx} on ${netName}: payment found, addressed to the artist's listed wallet, amount covers the $${c.depositAmount} deposit at the locked quote. BETA HONESTY: this checker is simulated — it validates the transaction ID's shape and the job record, it does not yet read a live blockchain. The state transition it drives is the real one the live checker will drive at hosting.`);
          break;
        }
        case "submitSketch": {
          await party("creator");
          if (c.status !== "deposit_paid" && c.status !== "sketch_approved") throw new Error("Sketches come after the deposit is confirmed.");
          if (!args.sketchImageUrl) throw new Error("Attach the sketch image first.");
          checkImageValue(args.sketchImageUrl, "Sketch");
          await assertAsset(ctx, args.sketchImageUrl, ["sketch"], ctx.account?.id ?? "", "Sketch");
          patch = { ...patch, status: "sketch_review", sketchImageUrl: refOf(args.sketchImageUrl), sketchSubmittedAt: now, sketchApproved: 0 };
          await addLedger(ctx, c.id, "Sketch submitted for approval", "Deposit Paid", "Sketch Approval", 0, "Buyer has 3 days to approve or use a revision — silence after 3 days counts as approved.");
          break;
        }
        case "approveSketch": {
          await party("buyer");
          if (c.status !== "sketch_review") throw new Error("No sketch is waiting for approval.");
          patch = { ...patch, status: "sketch_approved", sketchApproved: 1 };
          await addLedger(ctx, c.id, "Buyer approved the sketch", "Sketch Approval", "Sketch Approved", 0, "Direction locked. The artist now makes the final piece for the Vault.");
          if (creatorAcct && c.revisionsUsed === 0 && !(await hasStandingEvent(ctx, creatorAcct.id, "clean_sketch", c.id))) await earnStanding(ctx, creatorAcct.id, c.id, "clean_sketch", 5, "Milestone approved without revision");
          break;
        }
        case "requestRevision": {
          await party("buyer");
          if (c.status !== "sketch_review") throw new Error("Revisions apply while a sketch is waiting for approval.");
          if (c.revisionsUsed >= c.revisionsTotal) throw new Error(`All ${c.revisionsTotal} revisions from the brief are used up.`);
          patch = { ...patch, status: "deposit_paid", revisionsUsed: c.revisionsUsed + 1, sketchApproved: 0 };
          await addLedger(ctx, c.id, "Buyer requested a sketch revision", "Sketch Approval", "Deposit Paid", 0, `Revision ${c.revisionsUsed + 1} of ${c.revisionsTotal} used.`);
          break;
        }
        case "deemedApprove": {
          await partyOrStaff();
          if (c.status !== "sketch_review" || !c.sketchSubmittedAt) throw new Error("No sketch is waiting for approval.");
          if (now.getTime() - c.sketchSubmittedAt.getTime() < 3 * 24 * 3600 * 1000) throw new Error("Deemed approval needs 3 full days of buyer silence after the sketch was submitted.");
          patch = { ...patch, status: "sketch_approved", sketchApproved: 1 };
          await addLedger(ctx, c.id, "Sketch deemed approved (3 days of buyer silence)", "Sketch Approval", "Sketch Approved", 0, "The approval window passed with no response, so the direction counts as approved — artists are never trapped by silence.");
          if (creatorAcct && c.revisionsUsed === 0 && !(await hasStandingEvent(ctx, creatorAcct.id, "clean_sketch", c.id))) await earnStanding(ctx, creatorAcct.id, c.id, "clean_sketch", 5, "Milestone approved without revision");
          break;
        }
        case "deliverVault": {
          await party("creator");
          if (c.status !== "sketch_approved" && c.status !== "deposit_paid") throw new Error("Deliver to the Vault after the sketch is approved.");
          if (c.sketchApproved !== 1 && c.status !== "sketch_approved") throw new Error("The sketch gate comes first — the buyer must approve the direction before the final delivery.");
          if (!args.vaultFileUrl) throw new Error("Attach the final file first.");
          if (!refOf(args.vaultFileUrl).startsWith("asset:")) throw new Error("Vault originals must be uploaded files — attach the final file.");
          await assertAsset(ctx, args.vaultFileUrl, ["vault_original"], ctx.account?.id ?? "", "Vault file");
          if (args.vaultPreviewUrl) { checkImageValue(args.vaultPreviewUrl, "Vault preview"); await assertAsset(ctx, args.vaultPreviewUrl, ["vault_preview"], ctx.account?.id ?? "", "Vault preview"); }
          patch = { ...patch, status: "vault_delivered", vaultFileUrl: refOf(args.vaultFileUrl), vaultPreviewUrl: refOf(args.vaultPreviewUrl), vaultFileName: args.vaultFileName || "final-artwork", vaultDeliveredAt: now, deliveredNote: "Final piece delivered into the Vault — the buyer sees a watermarked preview only. The original unlocks when the balance is confirmed paid." };
          await addLedger(ctx, c.id, "Final piece delivered to the Vault", "Sketch Approved", "Delivered to Vault", 0, "Original stored server-side; buyer sees the watermarked, downscaled preview only. File hashed into the job record by its upload timestamp.");
          if (creatorAcct && c.deadline && now.getTime() <= c.deadline.getTime() && !(await hasStandingEvent(ctx, creatorAcct.id, "on_time", c.id))) await earnStanding(ctx, creatorAcct.id, c.id, "on_time", 15, "On-time delivery");
          break;
        }
        case "confirmBalance": {
          await party("creator");
          if (c.status !== "vault_delivered") throw new Error("The balance can only be confirmed after the piece is in the Vault.");
          if (net) throw new Error(`This job pays by crypto (${netName}) — the balance is confirmed by the transaction checker once the buyer submits the transaction ID, and the artwork unlocks automatically. No hand-confirmation on the crypto rail.`);
          await applyUnlock("Artist confirmed balance received — artwork UNLOCKED", "Paid buyer → artist directly on the artist's own account. The platform never held it and cannot refund it. The original file is now served to the buyer of record; every download is logged. If the buyer has not downloaded within 7 days, the platform marks the job released-by-platform (ghost release) in Admin.");
          break;
        }
        case "submitBalanceTx": {
          await party("buyer");
          if (!net) throw new Error("This job pays through the artist's external payment links — there's no crypto transaction to submit.");
          if (c.status !== "vault_delivered") throw new Error("The balance transaction is submitted after the piece is in the Vault.");
          if (c.balanceTxConfirmed === 1) throw new Error("The balance is already confirmed for this job.");
          checkTxid(net, args.txid);
          patch = { ...patch, balanceTx: args.txid.trim() };
          await addLedger(ctx, c.id, "Buyer submitted the balance transaction", "Delivered to Vault", "Delivered to Vault", Math.max(0, c.price - c.depositAmount), `Transaction ID ${args.txid.trim()} on ${netName}, sent buyer → artist wallet-to-wallet from the buyer's own wallet. The transaction checker verifies it next — a confirmed balance unlocks the artwork automatically.`);
          break;
        }
        case "checkBalanceTx": {
          await partyOrStaff();
          if (!net) throw new Error("This job doesn't pay by crypto — the artist confirms external payments by hand.");
          if (c.status !== "vault_delivered") throw new Error("The balance can only be checked after the piece is in the Vault.");
          if (!c.balanceTx) throw new Error("No balance transaction has been submitted yet — the buyer pastes the transaction ID from their wallet first.");
          if (c.balanceTxConfirmed === 1) throw new Error("The balance is already confirmed for this job.");
          patch = { ...patch, balanceTxConfirmed: 1 };
          await applyUnlock("Transaction checker confirmed the balance — artwork UNLOCKED automatically", `Checker result for transaction ${c.balanceTx} on ${netName}: payment found, addressed to the artist's listed wallet, amount covers the $${Math.max(0, c.price - c.depositAmount)} balance. The original is now served to the buyer of record; every download is logged. BETA HONESTY: this checker is simulated — it validates the transaction ID's shape and the job record, it does not yet read a live blockchain. The unlock it drives is the real one the live checker will drive at hosting.`);
          break;
        }
        case "walkAway": {
          await party("buyer");
          if (!c.deadline || now.getTime() <= c.deadline.getTime()) throw new Error("Walking away opens once the delivery deadline has passed with the milestone undelivered.");
          if (!["quoted", "deposit_paid", "sketch_review", "sketch_approved"].includes(c.status)) throw new Error("This job is no longer at a stage the buyer can walk away from.");
          patch = { ...patch, status: "walked_away" };
          await addLedger(ctx, c.id, "Buyer walked away after a missed deadline", c.status, "Walked Away", 0, "The job closes. Money already paid directly for milestones actually delivered stands — the platform never held it and cannot refund it. Remaining milestones are cancelled.");
          break;
        }
        case "escalate": {
          await party("creator");
          if (c.status !== "vault_delivered" || !c.vaultDeliveredAt) throw new Error("Escalation applies after Vault delivery, while the balance is unpaid.");
          if (now.getTime() - c.vaultDeliveredAt.getTime() < 7 * 24 * 3600 * 1000) throw new Error("Give the buyer 7 days from Vault delivery before escalating an unpaid balance.");
          patch = { ...patch, escalated: 1 };
          await addLedger(ctx, c.id, "Artist escalated unpaid balance to the owner", "Delivered to Vault", "Delivered to Vault", 0, "Balance unpaid 7+ days after delivery. The owner reviews the job record — non-payment after delivery is a ban-tier offence.");
          await db.insert(schema.moderationLog).values({ actorId: creatorAcct?.id ?? "system", actorLabel: creatorAcct ? `@${creatorAcct.username}` : "system", action: "balance_escalation", targetType: "commission", targetId: c.id, note: `Unpaid balance on "${c.title}" escalated by the artist.` });
          break;
        }
        case "withdrawVault": {
          await party("creator");
          if (c.status !== "vault_delivered" || !c.vaultDeliveredAt) throw new Error("Only an unpaid Vault delivery can be withdrawn.");
          if (now.getTime() - c.vaultDeliveredAt.getTime() < 7 * 24 * 3600 * 1000) throw new Error("The vault file can be withdrawn 7 days after delivery if the balance is still unpaid.");
          patch = { ...patch, status: "cancelled", vaultFileUrl: "", vaultPreviewUrl: "" };
          await addLedger(ctx, c.id, "Artist withdrew the vault file (balance never paid)", "Delivered to Vault", "Cancelled", 0, "Seven days passed with no balance payment, so the artist pulled the file. The job record (the evidence) stays.");
          break;
        }
        case "salvageVault": {
          await party("creator");
          if (c.status !== "vault_delivered" || !c.vaultDeliveredAt) throw new Error("Only an unpaid Vault delivery can move to salvage.");
          if (now.getTime() - c.vaultDeliveredAt.getTime() < 7 * 24 * 3600 * 1000) throw new Error("Salvage opens 7 days after delivery if the balance is still unpaid.");
          const lots = await db.select().from(schema.auctionLots); const lot = lots[0]; if (!lot) throw new Error("No open Weekly Vault lot.");
          await db.insert(schema.auctionItems).values({ id: uid("item"), lotId: lot.id, creatorName: creatorAcct?.displayName ?? c.creatorId, title: `${c.title} — unpaid vault piece`, kind: "picture", door: "salvage", shares: 1, mediaUrl: c.vaultPreviewUrl ?? "", status: "accepted", checklistJson: JSON.stringify({ noLikeness: true, noPrivateRefs: true, noExclusiveChar: true, rightsRetained: true }) });
          patch = { ...patch, status: "cancelled", vaultFileUrl: "" };
          await addLedger(ctx, c.id, "Artist routed the unpaid vault piece to Weekly Vault salvage", "Delivered to Vault", "Cancelled", 0, "Per the existing salvage opt-in rules: the creator retains resale rights and no balance was ever paid for this piece.");
          break;
        }
      }
      await db.update(schema.commissions).set(patch).where(eq(schema.commissions.id, args.id));
      return { ok: true as const, id: args.id };
    },
  }),

  buyPerk: defineAction({
    description: "Spends standing on a platform-issued perk (banner frame 60, name glow 120, +4 portfolio tiles 150, +2 Weekly Vault slots 200). Standing is deducted; perks are conveniences/cosmetics only — never money, never transferable.",
    request: z.object({ perk: z.enum(["banner_frame", "name_glow", "portfolio_tiles", "vault_slots"]) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAccount(ctx);
      if (!me.creatorId) throw new Error("Perks decorate a creator page — this account doesn't have one yet.");
      const CATALOG = { banner_frame: { price: 60, label: "Banner frame cosmetic" }, name_glow: { price: 120, label: "Name glow cosmetic" }, portfolio_tiles: { price: 150, label: "+4 portfolio tiles" }, vault_slots: { price: 200, label: "+2 Weekly Vault submission slots (per week)" } } as const;
      const perk = CATALOG[args.perk];
      const db = ctx.db;
      const cRows = await db.select().from(schema.creators).where(eq(schema.creators.id, me.creatorId));
      const creator = cRows[0]; if (!creator) throw new Error("Your creator page couldn't be found.");
      if (args.perk === "banner_frame" && creator.bannerFrame === 1) throw new Error("You already own the banner frame.");
      if (args.perk === "name_glow" && creator.nameGlow === 1) throw new Error("You already own the name glow.");
      if ((me.credits ?? 0) < perk.price) throw new Error(`That perk costs ${perk.price} standing and you have ${me.credits ?? 0}. Standing is earned by finishing jobs — it can't be bought.`);
      await db.update(schema.accounts).set({ credits: (me.credits ?? 0) - perk.price }).where(eq(schema.accounts.id, me.id));
      await db.insert(schema.standingEvents).values({ accountId: me.id, commissionId: "", kind: "spend", points: -perk.price, note: perk.label });
      if (args.perk === "banner_frame") await db.update(schema.creators).set({ bannerFrame: 1 }).where(eq(schema.creators.id, me.creatorId));
      if (args.perk === "name_glow") await db.update(schema.creators).set({ nameGlow: 1 }).where(eq(schema.creators.id, me.creatorId));
      if (args.perk === "portfolio_tiles") await db.update(schema.creators).set({ extraPortfolioTiles: (creator.extraPortfolioTiles ?? 0) + 4 }).where(eq(schema.creators.id, me.creatorId));
      if (args.perk === "vault_slots") await db.update(schema.creators).set({ extraVaultSlots: (creator.extraVaultSlots ?? 0) + 2 }).where(eq(schema.creators.id, me.creatorId));
      return { ok: true as const, id: me.creatorId };
    },
  }),

  adminSetVerified: defineAction({
    description: "Admin-only: toggles an account's Verified flag (the beta's manual ID check). Verifying awards +20 standing once; both directions are moderation-logged.",
    request: z.object({ accountId: z.string(), verified: z.boolean() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, args.accountId));
      const target = rows[0]; if (!target) throw new Error("That account couldn't be found.");
      await db.update(schema.accounts).set({ verified: args.verified ? 1 : 0, verifiedAt: args.verified ? new Date() : null }).where(eq(schema.accounts.id, args.accountId));
      if (args.verified && !(await hasStandingEvent(ctx, target.id, "verified"))) await earnStanding(ctx, target.id, "", "verified", 20, "Became Verified");
      await addModLog(ctx, me, args.verified ? "verify" : "unverify", "account", args.accountId, `@${target.username} ${args.verified ? "verified (manual ID check)" : "verification removed"}`);
      return { ok: true as const, id: args.accountId };
    },
  }),

  adminAddStrike: defineAction({
    description: "Admin-only: adds a strike (with note) to an account. Strikes show on the user's own My Profile and in the moderation log.",
    request: z.object({ accountId: z.string(), note: z.string().min(1).max(500) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireStaff(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, args.accountId));
      const target = rows[0]; if (!target) throw new Error("That account couldn't be found.");
      const id = uid("strike");
      await db.insert(schema.strikes).values({ id, accountId: args.accountId, note: args.note.trim(), createdBy: me.id });
      await addModLog(ctx, me, "strike", "account", args.accountId, `Strike for @${target.username}: ${args.note.trim()}`);
      return { ok: true as const, id };
    },
  }),

  adminRunGhostCheck: defineAction({
    description: "Admin-only: runs the ghost-release scan — v2 jobs unlocked 7+ days ago whose buyer never downloaded the original are marked released-by-platform, with a job ledger row and a moderation log entry.",
    request: z.object({}),
    response: z.object({ ok: z.literal(true), marked: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; marked: number }> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      const rows = await db.select().from(schema.commissions).where(eq(schema.commissions.status, "unlocked"));
      let marked = 0;
      for (const c of rows) {
        if (c.ghostReleased === 1 || (c.downloadCount ?? 0) > 0 || !c.unlockedAt || c.unlockedAt.getTime() > cutoff) continue;
        await db.update(schema.commissions).set({ ghostReleased: 1, updatedAt: new Date() }).where(eq(schema.commissions.id, c.id));
        await addLedger(ctx, c.id, "Released by platform (ghost release)", "Unlocked", "Unlocked", 0, "Balance was confirmed paid, the file unlocked, and 7 days passed with no download — the platform records the delivery as released under the ghost-delivery licence. The original remains downloadable by the buyer of record.");
        await addModLog(ctx, me, "ghost_release", "commission", c.id, `"${c.title}" marked released-by-platform (unlocked 7+ days, never downloaded)`);
        marked += 1;
      }
      return { ok: true as const, marked };
    },
  }),

  adminSetRole: defineAction({
    description: "Dev-only: appoints or removes a MODERATOR account. Moderators get the day-to-day moderation set (reports, quarantine, bans, strikes) but never invites, roles, refund debt, Trust Pool covers or standing grants. The dev/owner account's role can't be changed.",
    request: z.object({ accountId: z.string(), role: z.enum(["member", "mod"]) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, args.accountId));
      const target = rows[0]; if (!target) throw new Error("That account couldn't be found.");
      if (isAdminAccount(target)) throw new Error("The dev account's role is fixed — it's the dev account.");
      await db.update(schema.accounts).set({ role: args.role }).where(eq(schema.accounts.id, args.accountId));
      /* Privilege change = session rotation: the account's existing
         sessions (and their derived CSRF tokens) die with the old role. */
      await deleteAccountSessions(ctx.db, args.accountId);
      await addModLog(ctx, me, args.role === "mod" ? "role_mod_granted" : "role_mod_removed", "account", args.accountId, `@${target.username} ${args.role === "mod" ? "appointed moderator" : "returned to a regular member"}`);
      return { ok: true as const, id: args.accountId };
    },
  }),

  adminRecordRefundDebt: defineAction({
    description: "Dev-only: records a refund a seller owes but hasn't paid as a refund balance (negative-balance punishment) on their account. While a refund balance stands, the seller can't take new commissions or quote — the debt locks the door; nothing reaches into their wallet. Logged.",
    request: z.object({ accountId: z.string(), amount: z.number().int().min(1).max(100000), note: z.string().max(500).default("") }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, args.accountId));
      const target = rows[0]; if (!target) throw new Error("That account couldn't be found.");
      const next = (target.refundDebt ?? 0) + args.amount;
      await db.update(schema.accounts).set({ refundDebt: next }).where(eq(schema.accounts.id, args.accountId));
      await addModLog(ctx, me, "refund_debt_recorded", "account", args.accountId, `+$${args.amount} refund balance on @${target.username} (now $${next} owed)${args.note.trim() ? ` — ${args.note.trim()}` : ""}`);
      return { ok: true as const, id: args.accountId };
    },
  }),

  adminClearRefundDebt: defineAction({
    description: "Dev-only: clears a seller's refund balance once they've settled the refund with the buyer outside the platform. Logged with the amount cleared.",
    request: z.object({ accountId: z.string() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, args.accountId));
      const target = rows[0]; if (!target) throw new Error("That account couldn't be found.");
      const was = target.refundDebt ?? 0;
      if (was <= 0) throw new Error("That account has no refund balance to clear.");
      await db.update(schema.accounts).set({ refundDebt: 0 }).where(eq(schema.accounts.id, args.accountId));
      await addModLog(ctx, me, "refund_debt_cleared", "account", args.accountId, `$${was} refund balance cleared for @${target.username} — settled with the buyer`);
      return { ok: true as const, id: args.accountId };
    },
  }),

  adminCoverRefund: defineAction({
    description: "Dev-only: Trust Pool cover. When a scam is provable from a job's own record, the pool pays the buyer instantly (standing, from the platform's own funds — a goodwill policy, not insurance) and the covered amount lands on the SELLER's account as a refund balance they must settle before selling again. One cover per job, ever.",
    request: z.object({ commissionId: z.string(), amount: z.number().int().min(1).max(100000) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const me = await requireAdmin(ctx);
      const db = ctx.db;
      const rows = await db.select().from(schema.commissions).where(eq(schema.commissions.id, args.commissionId));
      const c = rows[0]; if (!c) throw new Error("That job couldn't be found.");
      if (c.v2 !== 1 || !c.buyerAccountId) throw new Error("Trust Pool covers apply to v2 jobs between real accounts.");
      if (args.amount > c.price) throw new Error(`A cover can't exceed the job's price ($${c.price}).`);
      if (await hasStandingEvent(ctx, c.buyerAccountId, "trust_pool_cover", c.id)) throw new Error("This job was already covered by the Trust Pool — one cover per job.");
      const buyerRows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, c.buyerAccountId));
      const buyer = buyerRows[0]; if (!buyer) throw new Error("The buyer of record couldn't be found.");
      const sellerRows = await db.select().from(schema.accounts).where(eq(schema.accounts.creatorId, c.creatorId));
      const seller = sellerRows[0] ?? null;
      /* The pool pays the BUYER instantly: spendable standing only —
         a cover is compensation, not earnings, so lifetime standing
         (levels) does not move. The event row is the one-cover lock. */
      await db.insert(schema.standingEvents).values({ accountId: buyer.id, commissionId: c.id, kind: "trust_pool_cover", points: args.amount, note: `Trust Pool cover for "${c.title}"` });
      await db.update(schema.accounts).set({ credits: (buyer.credits ?? 0) + args.amount }).where(eq(schema.accounts.id, buyer.id));
      if (seller) await db.update(schema.accounts).set({ refundDebt: (seller.refundDebt ?? 0) + args.amount }).where(eq(schema.accounts.id, seller.id));
      await addLedger(ctx, c.id, "Trust Pool covered the buyer — instantly", "Walked Away", "Trust Pool", args.amount, `The scam was provable from this job record, so the pool paid @${buyer.username} ${args.amount} standing immediately, from the platform's own funds — no claim form, no waiting. The same $${args.amount} is now @${seller?.username ?? "the seller"}'s refund balance: no new commissions or quotes until it's settled. The pool is a goodwill policy of the operator, not insurance.`);
      await addModLog(ctx, me, "trust_pool_cover", "commission", c.id, `$${args.amount} paid to @${buyer.username} for "${c.title}"; $${args.amount} refund balance placed on @${seller?.username ?? c.creatorId}`);
      return { ok: true as const, id: c.id };
    },
  }),

};
