import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db";
import * as schema from "./schema";

/* Standalone auth — the artifact's privileged crypto contract (see the
   Space's server/src/privileged.ts) moved server-side with IDENTICAL
   algorithms, parameters and stored formats. Parity is a Gate A property:
   - Argon2id via Bun.password, memoryCost 19456, timeCost 2 → "$argon2id$…"
   - scrypt N=2^17, r=8, p=1, maxmem 256MB → "scrypt$<N>$<salt>$<hash>"
   - legacy "<salt>:<hash>" (scrypt with Node default cost)
   Verification always uses the algorithm the stored hash declares. */

type BunPasswordApi = {
  hash: (pw: string, opts: { algorithm: "argon2id"; memoryCost: number; timeCost: number }) => Promise<string>;
  verify: (pw: string, hash: string) => Promise<boolean>;
};
function bunPassword(): BunPasswordApi | null {
  const g = globalThis as { Bun?: { password?: BunPasswordApi } };
  return g.Bun?.password ?? null;
}

const SCRYPT_N = 131072; // 2^17
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function scryptHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N, r: 8, p: 1, maxmem: SCRYPT_MAXMEM }).toString("hex");
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}
function scryptVerify(password: string, salt: string, expectedHex: string, n?: number): boolean {
  const opts = n ? { N: n, r: 8, p: 1, maxmem: SCRYPT_MAXMEM } : undefined;
  const calc = opts ? scryptSync(password, salt, 64, opts) : scryptSync(password, salt, 64);
  const orig = Buffer.from(expectedHex, "hex");
  return orig.length === calc.length && timingSafeEqual(orig, calc);
}

export async function hashPassword(password: string): Promise<string> {
  const bun = bunPassword();
  if (bun) return bun.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
  return scryptHash(password);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$argon2id$") || stored.startsWith("$2")) {
    const bun = bunPassword();
    if (!bun) return false;
    return bun.verify(password, stored);
  }
  if (stored.startsWith("scrypt$")) {
    const [, nStr, salt, hash] = stored.split("$");
    if (!nStr || !salt || !hash) return false;
    return scryptVerify(password, salt, hash, Number(nStr));
  }
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return scryptVerify(password, salt, hash);
}

/** 256-bit random session token (hex). Only its SHA-256 hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Unguessable invite code: 15 CSPRNG chars over an unambiguous alphabet,
    grouped for readability — identical to the artifact's generator. */
export function newInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(15);
  const raw = [...bytes].map(b => alphabet[b % alphabet.length]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`;
}

/** CSPRNG id (replaces the artifact's Math.random-based uid for everything,
    including non-security ids — one standard, per plan §3.5). */
export function uid(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}${Date.now().toString(36)}`;
}

/* ---- Owner / roles ---- */

/** The owner address comes from the OWNER_EMAIL env var (plan §3.5),
    compared after trim/lowercase. Unset → empty string → no account can
    match (fail closed: nobody is dev, everyone needs an invite). */
export function ownerEmail(): string {
  return (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
}

export type AccountRow = typeof schema.accounts.$inferSelect;

export function isAdminAccount(a: AccountRow): boolean {
  const oe = ownerEmail();
  return (oe !== "" && a.email.trim().toLowerCase() === oe) || a.isAdmin === 1;
}
export function roleOf(a: AccountRow): "dev" | "mod" | "member" {
  if (isAdminAccount(a)) return "dev";
  return a.role === "mod" ? "mod" : "member";
}

/* ---- Sessions ---- */

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // absolute expiry
export const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000; // idle expiry

export interface CreatedSession { rawToken: string; csrfToken: string }

/** Mints a fresh session: 256-bit token (only its hash is stored), plus the
    session's CSRF token (derived — see deriveCsrf; its hash is recorded on
    the session row per plan §3.4). */
export async function createSession(db: Db, accountId: string): Promise<CreatedSession> {
  const rawToken = newToken();
  const hash = tokenHash(rawToken);
  const csrfToken = deriveCsrf(hash);
  await db.insert(schema.sessions).values({
    token: hash,
    accountId,
    csrfHash: tokenHash(csrfToken),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    lastSeenAt: new Date(),
  });
  return { rawToken, csrfToken };
}

export interface ResolvedSession {
  account: AccountRow;
  session: typeof schema.sessions.$inferSelect;
}

/** Resolves a raw session token to its account, with the artifact's exact
    lifecycle: absolute + idle expiry (row deleted), hourly last-seen
    refresh, banned accounts lose all sessions on sight, and the owner
    flag/role is synced onto the owner row wherever it logs in. */
export async function resolveSession(db: Db, rawToken: string): Promise<ResolvedSession | null> {
  if (!rawToken) return null;
  const hash = tokenHash(rawToken);
  const sRows = await db.select().from(schema.sessions).where(eq(schema.sessions.token, hash));
  const s = sRows[0]; if (!s) return null;
  const now = Date.now();
  if (s.expiresAt.getTime() <= now || s.lastSeenAt.getTime() <= now - SESSION_IDLE_MS) {
    await db.delete(schema.sessions).where(eq(schema.sessions.token, s.token));
    return null;
  }
  if (now - s.lastSeenAt.getTime() > 3600 * 1000) {
    await db.update(schema.sessions).set({ lastSeenAt: new Date() }).where(eq(schema.sessions.token, s.token));
  }
  const aRows = await db.select().from(schema.accounts).where(eq(schema.accounts.id, s.accountId));
  const acct = aRows[0] ?? null;
  if (!acct) return null;
  if (acct.isBanned === 1) {
    await db.delete(schema.sessions).where(eq(schema.sessions.accountId, acct.id));
    return null;
  }
  const oe = ownerEmail();
  if (oe !== "" && acct.email.trim().toLowerCase() === oe && (acct.isAdmin !== 1 || acct.role !== "dev")) {
    await db.update(schema.accounts).set({ isAdmin: 1, role: "dev" }).where(eq(schema.accounts.id, acct.id));
    return { account: { ...acct, isAdmin: 1, role: "dev" as const }, session: s };
  }
  return { account: acct, session: s };
}

export async function deleteSession(db: Db, rawToken: string): Promise<void> {
  if (!rawToken) return;
  await db.delete(schema.sessions).where(eq(schema.sessions.token, tokenHash(rawToken)));
}

export async function deleteAccountSessions(db: Db, accountId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.accountId, accountId));
}

/* ---- CSRF ---- */

/* The per-session CSRF token is DERIVED, not stored raw: HMAC(server
   secret, "csrf:" + session-token-hash). It is unforgeable without the
   server secret, bound to exactly one session, and re-derivable by the
   server at GET /api/session time so a page refresh can restore it (the
   client keeps it in memory only). Rotation on privilege change is done
   by revoking the account's sessions (adminSetRole), which is strictly
   stronger than rotating a token the client could not re-learn anyway.
   The session row's csrf_hash column records the token's hash. */
function csrfSecret(): string {
  return process.env.APP_ENCRYPTION_KEY ?? process.env.SESSION_SECRET ?? "dev-only-csrf-secret";
}
export function deriveCsrf(sessionHash: string): string {
  return createHmac("sha256", csrfSecret()).update(`csrf:${sessionHash}`).digest("hex");
}
/** Constant-time check of a presented CSRF token for a session. */
export function csrfValid(sessionHash: string, presented: string): boolean {
  if (!sessionHash || !presented) return false;
  const a = Buffer.from(deriveCsrf(sessionHash), "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* Anonymous double-submit tokens: a random value + HMAC signature, carried
   in a cookie and echoed in the X-CSRF-Token header. The signing key is
   APP_ENCRYPTION_KEY (required in production); a clearly-named dev fallback
   keeps local runs working. */
function anonSecret(): string {
  return process.env.APP_ENCRYPTION_KEY ?? process.env.SESSION_SECRET ?? "dev-only-anon-csrf-secret";
}
export function newAnonCsrf(): string {
  const raw = newToken();
  const sig = createHmac("sha256", anonSecret()).update(raw).digest("hex");
  return `${raw}.${sig}`;
}
export function anonCsrfValid(cookieValue: string, presented: string): boolean {
  if (!cookieValue || !presented || cookieValue !== presented) return false;
  const [raw, sig] = cookieValue.split(".");
  if (!raw || !sig) return false;
  const expect = createHmac("sha256", anonSecret()).update(raw).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expect, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---- Cookies ---- */

export const SESSION_COOKIE = process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production"
  ? "__Host-ce_session"
  : "ce_session";
export const ANON_CSRF_COOKIE = "ce_csrf";

export function sessionCookieHeader(rawToken: string): string {
  const secure = SESSION_COOKIE.startsWith("__Host-");
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${rawToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export function clearSessionCookieHeader(): string {
  const secure = SESSION_COOKIE.startsWith("__Host-");
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
export function anonCsrfCookieHeader(value: string): string {
  const secure = SESSION_COOKIE.startsWith("__Host-");
  return `${ANON_CSRF_COOKIE}=${value}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24}${secure ? "; Secure" : ""}`;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
