# Commission Escrow — Standalone Port Build Log

Phase 1 scope (owner ruling, 2026-11-14): faithful standalone port with the
**simulated** crypto checker carried over exactly as it behaves in the Space.
The live blockchain checker is phase 2 — not built here, not stubbed as "live".
Plan: `../STANDALONE-PORT-PLAN.md` (steps 0–7 + deploy pack; step 8 deferred).

## Environment facts (this VM)

- Bun 1.4.4, Node 24. No local Postgres server, no Docker.
- Local DB testing uses **PGlite** (real Postgres in WASM) behind the Drizzle
  **pg dialect**; migrations are plain Postgres SQL and run unchanged on
  Render Postgres later. Noted here per instructions, not hidden.
- VM egress: GETs fine, POSTs hang → build/test must not depend on external
  services. Object storage is tested against the local file-backed driver.

## Step status — ALL PHASE-1 STEPS LANDED (2026-11-14)

- [x] Plan read in full; source inventoried read-only (37 actions, 16 tables
      confirmed against `server/src/actions.ts` / `schema.ts` at freeze).
- [x] Step 0 — parity pack: password-hash fixtures (all three formats) +
      golden authorization matrix as automated tests.
- [x] Step 1 — standalone skeleton (server + client build, no Hatch refs;
      grep-clean for @hatch/@space/localStorage in client source + bundle).
- [x] Step 2 — Postgres schema (pg-core, 16 tables + media_assets +
      background_job_runs + sessions.csrf_hash), hand-written baseline
      migration, idempotent migration runner, seed CLI.
- [x] Step 3 — HTTP transport: `POST /api/rpc/<action>` allowlist router,
      Zod in/out validation, stable error shape, request ids; client API
      shell per CONTRACT.md.
- [x] Step 4 — cookie sessions (30-day absolute / 7-day idle, hash-only
      storage), CSRF (per-session derived token + anonymous double-submit,
      Origin check, handler never runs on failure), password parity.
- [x] Step 5 — authorization parity + public/private read split (plan §4.1
      defaults, see Decisions).
- [x] Step 6 — object storage behind env-selected driver (local + Bun S3),
      upload init/blob/complete with magic-byte sniff + SHA-256,
      `GET /media/<id>` with per-request quarantine/ban/party checks
      (vault_original always 404), `GET /api/jobs/<id>/vault-file`
      (buyer-of-record, download logged in a transaction).
- [x] Step 7 — jobs:tick (ghost scan + expired-session + stale-attempt
      cleanup, conditional updates, one background_job_runs row per run).
- [x] Verification — §9 checklist executed locally as far as possible
      (results below); **59 automated tests, all passing**.
- [x] Deploy pack — `render.yaml` (web + cron, **no database stanza** —
      Postgres created LAST by hand), `.env.example` (names only),
      `DEPLOY.md` (ordered owner steps), `Dockerfile`, `.gitignore`.

## Decisions taken (plan defaults, owner saw the plan and said "start")

- §4.1.1 getState split: real-account jobs/ledger are party/staff-scoped.
  Seed/demo jobs with **no real account on either side** stay publicly
  readable as display-only content (fictional data; Jobs page is a demo
  surface). Any job touching a real account is never public.
- §4.1.2 actOnCommission: rejected for real-account (v2) jobs; staff-only
  for unlinked demo jobs on the live build.
- §4.1.3 seedPrototype: CLI-only (`scripts/seed-demo.ts`); no HTTP action.
- §4.1.4 placeBid: disabled on the standalone build (clear in-product
  message); Weekly Vault display + submissions stay live.
- §4.1.5 Sample shops display-only: in milestoneAct, a side with no account
  is staff-gated instead of open; anonymous createCommission now requires a
  signed-in account (every beta tester has one; demo jobs come from seed).
- Integer 0/1 flags kept (plan §3.4 recommendation) to reduce parity risk.
- Every RPC handler runs inside a Postgres transaction (plan §2.4 lists the
  multi-row writes needing atomicity; making it uniform is strictly stronger
  than the SQLite sequential writes it replaces) — **with one deliberate
  exception found in testing: `logIn`.** The login throttle records a
  failed attempt and then throws; under a transaction the attempt row
  rolled back and the throttle silently never accumulated (the Space's
  per-statement autocommit let it persist). logIn's writes are
  single-statement and self-consistent, so it runs unwrapped. Regression
  covered by the throttle test in `tests/checklist-extras.test.ts`.
- Media upload: client uploads bytes to the app server, which writes them
  through the storage interface (uniform for local + S3 drivers). This is a
  deliberate simplification of plan §3.6's presigned direct-to-bucket flow —
  same interface boundary, no bucket CORS needed, fine at beta media sizes
  (≤ ~2.2 MB). Presigned direct upload can replace the transport later
  without touching actions or DTOs.
- Cookie name: `__Host-ce_session` when Secure (production), `ce_session`
  for local http testing (env-driven). Session rules unchanged either way.
- Per-IP login throttle: NOT added — plan says add only after confirming
  Render proxy-header behaviour, which is a deploy-time check (in DEPLOY.md).
  The per-account 5-in-15-min rule is preserved exactly.
- crypto_payment_intents / crypto_check_events tables: NOT created — they
  belong to the phase-2 live checker (plan step 8), out of scope here.
- Password-hash fixtures: generated with the old privileged.ts **parameters**
  (Argon2id m=19456 t=2 via Bun.password; scrypt N=2^17; legacy default
  scrypt) — the artifact runtime cannot be executed from here, so fixtures
  are produced by the identical algorithms/parameters and verified against
  the ported verifier. Method noted honestly; parameters are the parity
  contract and they match privileged.ts exactly.

## Verification results — plan §9, executed locally (2026-11-14)

Test evidence: `bun run test` → **59 pass / 0 fail, 232 assertions**
(`tests/auth-parity`, `jobs`, `e2e-flow`, `trust-pool-mod`,
`authorization-matrix`, `checklist-extras`), plus a live smoke run of the
real server (seeded PGlite + local storage): /healthz ok, /readyz shows
`0001_baseline.sql`, seeded getState = 5 creators / 4 demo jobs / 5 items,
seed media served 200 with real bytes, jobs:tick clean + idempotent.
`bun run build` passes (client bundle + server bundle + both typechecks).

- **§9.1 Deployment smoke** — PARTIAL (local only): healthz/readyz PASS;
  seeded golden counts PASS (5/18/4/9/1/5/8/20 + 27 media assets, verified
  by the seed pass: no `data:` URLs remain, all bytes match size+SHA-256).
  NOT verified locally: responsive rendering at 360/390/430px + desktop
  (no browser in this environment — the client is a faithful copy of the
  Space client, same CSS; owner's phone verdict at deploy), MP4 inline
  playback on a device, Render restart persistence.
- **§9.2 Signup/invites/bootstrap** — PASS locally: owner born dev with no
  code; bogus code → generic message; exactly 10 launch codes; spent code
  can't be reused; failed signup never spends a code; duplicate
  email/username → current messages; <15-char and common passwords
  rejected; new accounts start at 0 standing, Level 1. NOT tested:
  two *simultaneous* signups racing the last use (the conditional SQL
  increment is the same mechanism the Space used; sequential equivalent
  is tested).
- **§9.3 Sessions/passwords/CSRF** — PASS locally: all three hash fixtures
  verify correct + reject wrong; cookie flags asserted (HttpOnly,
  SameSite=Lax, Path=/; Secure + `__Host-` prefix are production-config —
  asserted by config, not locally observable over http); no token in any
  JSON payload (auth responses carry only the CSRF token; raw session
  token exists solely in the cookie); login mints fresh session; logout
  kills server-side; 5-failure throttle engages (after the logIn
  transaction fix above); POST without CSRF / with foreign Origin → 403
  and handler never runs; GET on RPC routes → 404; banned user's live
  session dies immediately.
- **§9.4 Authorization matrix** — PASS locally, automated: wrong-party and
  unrelated milestoneAct steps refused with the original messages; theme
  edit / post delete by non-owner indistinguishable from not-found; a
  member refused by **all 16 admin actions**; mod refusals for the whole
  dev-only set (invites, roles, grants, verify, ghost, debt, covers) +
  mod's adminGetState has `invites: []`; mod CAN dismiss reports (the
  day-to-day set); role appointment revokes the mod's existing sessions;
  owner can't be banned, dev role fixed; public DTOs contain no emails,
  hashes, refund debt, or ban-evasion data (serialized-payload sweep).
- **§9.5 External-rail flow** — PASS locally: full walk (external rail
  exercised inside the Trust Pool scenario; crypto walk in e2e); Level 1
  cap blocks $100, $70 ok; revision consumed + exhaustion refused; deemed
  approval refused before 3 days, succeeds after (clock adjusted in DB);
  standing golden totals artist 85 / buyer 40; refund-debt blocks new
  commissions + quotes, clearing restores; verified-only gate refuses
  unverified, accepts verified; walk-away after missed deadline; escalate
  + withdraw refused before 7 days, escalate works after.
- **§9.6 Crypto/checker** — SIMULATED SUBSET PASS locally: unlisted rail
  refused at creation; malformed + wrong-network-shape txids refused;
  no-txid check refused (job does not advance); manual confirm refused on
  the crypto rail; seed-phrase wallet submission rejected, nothing
  stored; checker ledger rows carry the "BETA HONESTY: this checker is
  simulated" wording. All live-checker items (confirmations, wrong
  address/asset, underpaid, duplicates on-chain, provider outage, xpub)
  are **phase 2** — not built, per the owner's ruling.
- **§9.7 Vault/media** — PASS locally: vault original 404 via /media at
  every stage incl. for the buyer; only the buyer of record downloads
  after unlock (artist + anonymous refused); download count + ledger
  increment once per download (1, then 2); oversized init, non-MP4 video,
  and fake-magic image bytes all refused; quarantine removes a post's
  media from delivery immediately, restore brings it back with identical
  SHA-256.
- **§9.8 Admin** — PASS locally: anonymous report files and appears in
  queue; mod dismiss + log entry verified; ban kills session, blocks
  login, burns standing (Space behaviour, preserved in code); unban
  restores login, not standing; fingerprint tripwire flags a same-device
  signup silently (account fully usable); verify awards +20 exactly once;
  Trust Pool cover pays buyer instantly (spendable only, lifetime
  unmoved), same amount becomes seller refund debt, second cover refused.
  NOT separately re-tested: quarantine/restore/delete for every target
  type (post type tested end-to-end; the other types share the Space's
  code paths verbatim) and the delete two-step (client-side confirm,
  client copied faithfully).
- **§9.9 Background/ops** — PASS locally: tick writes one run row per
  run, ghost-marks exactly once (downloaded + recent jobs untouched),
  second tick is a no-op, expired sessions + stale attempts swept, empty
  DB ticks cleanly. NOT local: Render cron schedule itself, DB
  export/restore drill (deploy-time), production log hygiene, day-21/28
  reminders (DEPLOY.md instructs the owner to set them when Postgres is
  created).

## Deviations / unverified (plain list)

1. **Live blockchain checker: not built** (phase 2 by the owner's ruling).
   The simulated checker is carried over exactly, honestly labelled
   in-product. §9.6's live items and plan §11 item 3 cannot pass until
   phase 2.
2. **Local DB is PGlite**, not a real Postgres server (none exists on this
   VM). Schema + migrations are genuine pg dialect/SQL and the code takes
   `DATABASE_URL` → node-postgres unchanged; a real-Postgres run is still
   a deploy-time first (low risk, not zero).
3. **S3 driver untested against a real bucket** (no external accounts in
   this phase, per scope). It uses Bun's native S3Client behind the same
   interface the local driver passed every test through; R2 verification
   is a deploy step.
4. **Responsive/device rendering unverified** — no browser available to
   this build. The client is a surgical copy of the Space client (114-line
   diff, all transport/media/session changes); layout CSS is byte-
   identical except the root class rename. Owner's phone verdict pending,
   as with the Space.
5. **Just-uploaded media previews** (client worker's flag): after an
   upload, in-editor previews hold an `asset:<id>` ref and render only
   after the next server round-trip returns the `/media/<id>` URL.
   Saved content displays correctly; uploads themselves are unaffected.
   A small object-URL preview shim would fix the cosmetics if wanted.
6. **§4.1.1 interpretation**: demo jobs with no real account on either
   side stay publicly readable (display-only). This is the plan's stated
   default; flagged because it is an interpretation, not a quote.
7. **getVaultFile is not an RPC action** standalone (per CONTRACT): it is
   the `/api/jobs/<id>/vault-file` route with the original checks and
   messages; staff may download a *demo* job's original (no buyer of
   record exists) — real-account jobs are buyer-only, no staff exemption,
   matching the original.
8. **Duplicate-txid rejection across jobs** is a live-checker (phase 2)
   property; the simulated checker, like the Space's, does not track
   txids across jobs.
9. **Race test** for the last invite use is sequential-equivalent only
   (see §9.2 note); the guard itself is the Space's conditional-increment
   mechanism, preserved.
10. **Password fixtures** were generated with the old code's exact
    parameters rather than by executing the artifact runtime (impossible
    from here) — see Decisions.

## 2026-11-14 — Live copy fix (Colin's ruling: "no longer a prototype")
- Removed every user-facing "prototype" label from client/src/App.tsx (footer,
  login, signup, account page, Terms). The hosted site is a live, invite-only
  beta; footer now reads "Live beta — invite-only test."
- Terms substance unchanged: clause 1 still describes dollar figures as
  simulated credits — flagged to Colin as a separate ruling, not silently
  rewritten. Simulated-checker honesty labels untouched (checker is still
  simulated until phase 2).
