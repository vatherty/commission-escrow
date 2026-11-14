# Standalone port — internal contract (all workstreams build against this)

Source of truth for behaviour: `~/workspace/ts-spaces/commission-escrow/`
(READ-ONLY). Plan: `../STANDALONE-PORT-PLAN.md`.

## HTTP surface (one origin, Bun server)

- `POST /api/rpc/<actionName>` — JSON body = action args **without** `token`.
  Response = the action's response JSON. Errors: HTTP 400 with
  `{ "ok": false, "error": { "code": "error", "message": "<exact current message>" } }`;
  the client surfaces `message` exactly as the Space client surfaced thrown errors.
  Unknown action → 404. GET on /api/rpc/* → 404 (mutations are POST-only).
- `GET /api/session` → `{ account: <accountOut|null>, csrfToken: "<string>" }`.
  Always returns a csrfToken: the session-bound one when logged in, otherwise
  an anonymous double-submit token (also set as cookie `ce_csrf`).
- `GET /healthz` → `{ ok: true }` (no DB). `GET /readyz` → DB + migration check.
- Auth actions stay RPC actions (`signUp`, `logIn`, `logOut`) with one change:
  the auth response is `{ csrfToken, account }` (was `{ token, account }`).
  On signUp/logIn success the server sets the session cookie; logOut deletes
  the session server-side and clears the cookie.
- Session cookie: `__Host-ce_session` (Secure) in production,
  `ce_session` locally; `HttpOnly; SameSite=Lax; Path=/`. Raw session token
  exists ONLY in this cookie — never in JSON, never in localStorage.
- CSRF: every POST must carry header `X-CSRF-Token`. Authenticated: token is
  per-session (SHA-256 hash stored on the session row; raw value returned by
  signUp/logIn/`GET /api/session`, kept by the client **in memory only**).
  Anonymous: double-submit — `GET /api/session` sets cookie `ce_csrf` and
  returns the same value as `csrfToken`; client echoes it in the header.
  Mutations also check `Origin` (when present) against the app origin.
  CSRF/origin failure → 403 `{ ok:false, error:{ code:"csrf", message:"…" } }`,
  handler never runs.

## Client API layer (`client/src/api.ts`)

- Same call shape as today: `api.<action>(args)` returning typed responses,
  types imported type-only from `../../server/src/actions` (the standalone
  actions module exports the same `Actions` registry type).
- The transport strips any `token` key from args (App.tsx still passes a
  `token` prop around; in the standalone client that value is the **CSRF
  token**, held in React state + a module-level variable — never persisted).
- After signUp/logIn, the response's `csrfToken` becomes the in-memory token.
  On page load the client calls `GET /api/session` (the `getSession` action
  name maps to this GET) to restore the account + CSRF token from the cookie.
- React Query invalidation mirrors today's client behaviour per mutation
  (the old server-side `ctx.invalidateQueries()` calls are gone; the client
  already invalidates the same keys it did in the Space).

## Media (Step 6)

- Stored DB value for uploaded media is an **asset reference**: `asset:<id>`.
  DTO mappers convert `asset:<id>` → `/media/<id>` in responses. External
  http(s) image URLs remain allowed exactly where they are today.
- Upload flow (authenticated, CSRF-protected):
  1. `POST /api/uploads/init` `{ kind, mimeType, byteSize }` → `{ assetId, uploadPath }`.
     Kinds: `profile|banner|background|showcase|portfolio|post_image|post_video|auction|sketch|vault_preview|vault_original`.
     Caps (bytes): image kinds ≤ 700,000; `post_video` ≤ 2,100,000;
     `vault_original` ≤ 2,200,000 (today's effective data-URL caps).
  2. `PUT <uploadPath>` with the raw bytes (same-origin, cookie + CSRF header).
  3. `POST /api/uploads/complete` `{ assetId }` → `{ ok: true, ref: "asset:<id>" }`.
     Server sniffs content (JPEG/PNG/GIF/WebP images; MP4 for video kinds),
     records SHA-256, marks the asset ready. Uncompleted assets are unusable.
- Client helpers (in api.ts): `uploadAsset(blob, kind): Promise<string>`
  returning the `asset:<id>` ref; canvas helpers produce Blobs, not data URLs.
- `GET /media/<assetId>` — serves display media after a per-request check:
  quarantined or banned-owner content → 404; `vault_original` → always 404;
  unattached asset → owner-only. Never a raw storage URL.
- Vault download: `GET /api/jobs/<commissionId>/vault-file` — cookie session
  required; runs the getVaultFile checks (unlocked + buyer of record; staff
  only when the job has no buyer account), logs the download (count + ledger)
  in a transaction, then streams the bytes with
  `Content-Disposition: attachment` and header `X-Download-Count: <n>`.
  The client turns the response into a download and shows the count.
- `getVaultFile` is NOT an RPC action in the standalone registry.

## Storage interface (`server/src/storage.ts`)

```ts
export interface StorageDriver {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
export function getStorage(): StorageDriver; // env-selected, cached
```

Env: `STORAGE_DRIVER=local|s3` (default `local`), `STORAGE_DIR` (local root,
default `./storage-data`), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (s3 driver uses Bun's native
S3Client). Keys are server-generated: `assets/<assetId>`.

## Server context (registry)

```ts
export interface AppCtx {
  db: Db;                       // Drizzle pg db (or the tx handle)
  account: AccountRow | null;   // resolved from the session cookie
  sessionHash: string | null;   // sha256 of the presented session token
  csrfToken: string | null;     // set by startSession for auth responses
  setSessionCookie: string | null; // raw token the router must Set-Cookie
  clearSessionCookie: boolean;
  requestId: string;
  ip: string | null;
}
```

Handlers keep today's helper names: `requireAccount(ctx)`, `requireStaff(ctx)`,
`requireAdmin(ctx)` — but they read `ctx.account` (no token argument).
`db.batch` is gone; the router runs every handler inside `db.transaction`.
`ctx.invalidateQueries()` calls are deleted. `uid()` is CSPRNG-based.
`OWNER_EMAIL` comes from env (trim/lowercase compare, fail closed when unset).
