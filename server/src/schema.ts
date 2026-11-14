import { index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* Standalone Postgres schema — a faithful conversion of the artifact's
   SQLite schema (same tables, columns, defaults and 0/1 integer flags;
   timestamps become timestamptz). Additions required by the standalone
   design (port plan §3.4): sessions.csrf_hash, media_assets,
   background_job_runs, database-level uniqueness for email/username/invite
   code, foreign keys where the data model is unambiguous, and indexes for
   the standalone query patterns. The legacy SQLite `entries` table from
   migration 0001 is NOT ported (not in the current schema). */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().$defaultFn(() => new Date());

export const creators = pgTable("creators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  handle: text("handle").notNull(),
  tagline: text("tagline").notNull(),
  accent: text("accent").notNull(),
  bio: text("bio").notNull(),
  status: text("status", { enum: ["open", "waitlist", "closed"] }).notNull().default("open"),
  turnaround: text("turnaround").notNull(),
  pricesJson: text("prices_json").notNull(),
  willDoJson: text("will_do_json").notNull(),
  wontDoJson: text("wont_do_json").notNull(),
  portfolioJson: text("portfolio_json").notNull(),
  pfpUrl: text("pfp_url").notNull().default(""),
  bannerUrl: text("banner_url").notNull().default(""),
  bgColor: text("bg_color").notNull().default("#fffef9"),
  panelColor: text("panel_color").notNull().default("#ffffff"),
  accent2: text("accent2").notNull().default("#facc15"),
  headingColor: text("heading_color").notNull().default("#334155"),
  bodyColor: text("body_color").notNull().default("#475569"),
  bgImageUrl: text("bg_image_url").notNull().default(""),
  showcaseUrl: text("showcase_url").notNull().default(""),
  portfolioImagesJson: text("portfolio_images_json").notNull().default("{}"),
  quarantined: integer("quarantined").notNull().default(0),
  quarantinedAt: ts("quarantined_at"),
  quarantineNote: text("quarantine_note").notNull().default(""),
  portfolioQuarantineJson: text("portfolio_quarantine_json").notNull().default("[]"),
  paymentMethodsJson: text("payment_methods_json").notNull().default("[]"),
  cryptoWalletsJson: text("crypto_wallets_json").notNull().default("[]"),
  verifiedOnly: integer("verified_only").notNull().default(0),
  bannerFrame: integer("banner_frame").notNull().default(0),
  nameGlow: integer("name_glow").notNull().default(0),
  extraPortfolioTiles: integer("extra_portfolio_tiles").notNull().default(0),
  extraVaultSlots: integer("extra_vault_slots").notNull().default(0),
  createdAt: createdAt(),
});

/** Relational category tags for creators — one row per (creator, category). */
export const creatorCategories = pgTable("creator_categories", {
  creatorId: text("creator_id").notNull().references(() => creators.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
}, (t) => [primaryKey({ columns: [t.creatorId, t.category] })]);

export const commissions = pgTable("commissions", {
  id: text("id").primaryKey(),
  creatorId: text("creator_id").notNull().references(() => creators.id),
  buyerName: text("buyer_name").notNull(),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  refsText: text("refs_text").notNull().default(""),
  budget: integer("budget").notNull(),
  price: integer("price").notNull(),
  kind: text("kind", { enum: ["standard", "extended"] }).notNull().default("standard"),
  rail: text("rail", { enum: ["reserve", "vault"] }).notNull().default("reserve"),
  status: text("status").notNull().default("requested"),
  deadline: ts("deadline"),
  sketchApproved: integer("sketch_approved").notNull().default(0),
  revisionsUsed: integer("revisions_used").notNull().default(0),
  revisionsTotal: integer("revisions_total").notNull().default(2),
  deliveredNote: text("delivered_note").notNull().default(""),
  disputeReason: text("dispute_reason").notNull().default(""),
  counterPrice: integer("counter_price"),
  blocksTotal: integer("blocks_total").notNull().default(1),
  blocksReleased: integer("blocks_released").notNull().default(0),
  blockAmount: integer("block_amount").notNull().default(50),
  buyerAccountId: text("buyer_account_id").references(() => accounts.id),
  creditsHeld: integer("credits_held").notNull().default(0),
  creditsReleased: integer("credits_released").notNull().default(0),
  depositAmount: integer("deposit_amount").notNull().default(0),
  depositConfirmed: integer("deposit_confirmed").notNull().default(0),
  depositConfirmedAt: ts("deposit_confirmed_at"),
  sketchImageUrl: text("sketch_image_url").notNull().default(""),
  sketchSubmittedAt: ts("sketch_submitted_at"),
  vaultFileUrl: text("vault_file_url").notNull().default(""),
  vaultPreviewUrl: text("vault_preview_url").notNull().default(""),
  vaultFileName: text("vault_file_name").notNull().default(""),
  vaultDeliveredAt: ts("vault_delivered_at"),
  balanceConfirmedAt: ts("balance_confirmed_at"),
  unlockedAt: ts("unlocked_at"),
  downloadCount: integer("download_count").notNull().default(0),
  ghostReleased: integer("ghost_released").notNull().default(0),
  payMethod: text("pay_method").notNull().default(""),
  depositTx: text("deposit_tx").notNull().default(""),
  depositTxConfirmed: integer("deposit_tx_confirmed").notNull().default(0),
  balanceTx: text("balance_tx").notNull().default(""),
  balanceTxConfirmed: integer("balance_tx_confirmed").notNull().default(0),
  v2: integer("v2").notNull().default(0),
  escalated: integer("escalated").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
}, (t) => [
  index("commissions_buyer_idx").on(t.buyerAccountId),
  index("commissions_creator_idx").on(t.creatorId),
  index("commissions_status_idx").on(t.status),
]);

export const ledgerEntries = pgTable("ledger_entries", {
  id: serial("id").primaryKey(),
  commissionId: text("commission_id").notNull().references(() => commissions.id),
  label: text("label").notNull(),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  amount: integer("amount").notNull(),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [index("ledger_commission_idx").on(t.commissionId)]);

export const auctionLots = pgTable("auction_lots", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  theme: text("theme").notNull(),
  reserve: integer("reserve").notNull(),
  currentBid: integer("current_bid").notNull().default(0),
  bidder: text("bidder").notNull().default(""),
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  username: text("username").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  accountType: text("account_type", { enum: ["buyer", "creator"] }).notNull().default("buyer"),
  creatorId: text("creator_id"),
  role: text("role", { enum: ["member", "mod", "dev"] }).notNull().default("member"),
  refundDebt: integer("refund_debt").notNull().default(0),
  isAdmin: integer("is_admin").notNull().default(0),
  isBanned: integer("is_banned").notNull().default(0),
  credits: integer("credits").notNull().default(0),
  verified: integer("verified").notNull().default(0),
  verifiedAt: ts("verified_at"),
  lifetimeEarned: integer("lifetime_earned").notNull().default(0),
  deviceFingerprint: text("device_fingerprint").notNull().default(""),
  banEvasionFlag: integer("ban_evasion_flag").notNull().default(0),
  perksJson: text("perks_json").notNull().default("{}"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("accounts_email_lower_idx").on(sql`lower(${t.email})`),
  uniqueIndex("accounts_username_lower_idx").on(sql`lower(${t.username})`),
]);

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  csrfHash: text("csrf_hash").notNull().default(""),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull().$defaultFn(() => new Date()),
  createdAt: createdAt(),
}, (t) => [
  index("sessions_account_idx").on(t.accountId),
  index("sessions_expires_idx").on(t.expiresAt),
]);

export const loginAttempts = pgTable("login_attempts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: createdAt(),
}, (t) => [index("login_attempts_email_time_idx").on(t.email, t.createdAt)]);

export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  creatorId: text("creator_id").notNull().references(() => creators.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  priceNote: text("price_note").notNull().default(""),
  imageUrl: text("image_url").notNull().default(""),
  videoUrl: text("video_url").notNull().default(""),
  quarantined: integer("quarantined").notNull().default(0),
  quarantinedAt: ts("quarantined_at"),
  quarantineNote: text("quarantine_note").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [index("posts_creator_time_idx").on(t.creatorId, t.createdAt)]);

export const postCategories = pgTable("post_categories", {
  postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
}, (t) => [primaryKey({ columns: [t.postId, t.category] })]);

export const auctionItems = pgTable("auction_items", {
  id: text("id").primaryKey(),
  lotId: text("lot_id").notNull().references(() => auctionLots.id),
  creatorName: text("creator_name").notNull(),
  title: text("title").notNull(),
  kind: text("kind", { enum: ["picture", "video"] }).notNull(),
  door: text("door", { enum: ["fresh", "salvage"] }).notNull(),
  shares: integer("shares").notNull(),
  mediaUrl: text("media_url").notNull().default(""),
  status: text("status").notNull().default("accepted"),
  checklistJson: text("checklist_json").notNull().default("{}"),
  quarantined: integer("quarantined").notNull().default(0),
  quarantinedAt: ts("quarantined_at"),
  quarantineNote: text("quarantine_note").notNull().default(""),
  createdAt: createdAt(),
});

export const inviteCodes = pgTable("invite_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  maxUses: integer("max_uses").notNull(),
  usesCount: integer("uses_count").notNull().default(0),
  createdBy: text("created_by").notNull().default(""),
  disabled: integer("disabled").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("invite_codes_code_idx").on(t.code)]);

export const reports = pgTable("reports", {
  id: text("id").primaryKey(),
  reporterAccountId: text("reporter_account_id").references(() => accounts.id, { onDelete: "set null" }),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  itemTitle: text("item_title").notNull().default(""),
  reason: text("reason").notNull(),
  detail: text("detail").notNull().default(""),
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
}, (t) => [index("reports_status_time_idx").on(t.status, t.createdAt)]);

export const moderationLog = pgTable("moderation_log", {
  id: serial("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  actorLabel: text("actor_label").notNull().default(""),
  action: text("action").notNull(),
  targetType: text("target_type").notNull().default(""),
  targetId: text("target_id").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [index("moderation_log_time_idx").on(t.createdAt)]);

export const strikes = pgTable("strikes", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().default(""),
  createdAt: createdAt(),
});

/** Standing ledger. commissionId is "" for non-job events, so it carries no
    FK (documented deferral, same as the artifact); accountId does. */
export const standingEvents = pgTable("standing_events", {
  id: serial("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  commissionId: text("commission_id").notNull().default(""),
  kind: text("kind").notNull(),
  points: integer("points").notNull(),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [index("standing_account_kind_comm_idx").on(t.accountId, t.kind, t.commissionId)]);

/** Uploaded media, stored in private object storage — DB fields that used
    to hold data URLs now hold `asset:<id>` references to rows here. */
export const mediaAssets = pgTable("media_assets", {
  id: text("id").primaryKey(),
  ownerAccountId: text("owner_account_id"),
  kind: text("kind").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull().default(0),
  sha256: text("sha256").notNull().default(""),
  width: integer("width"),
  height: integer("height"),
  ready: integer("ready").notNull().default(0),
  createdAt: createdAt(),
  deletedAt: ts("deleted_at"),
}, (t) => [index("media_assets_owner_idx").on(t.ownerAccountId)]);

/** One row per jobs:tick run, so "did the checker/cleanup run?" is
    answerable from data. */
export const backgroundJobRuns = pgTable("background_job_runs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().default("tick"),
  startedAt: ts("started_at").notNull().$defaultFn(() => new Date()),
  finishedAt: ts("finished_at"),
  countsJson: text("counts_json").notNull().default("{}"),
  error: text("error").notNull().default(""),
});
