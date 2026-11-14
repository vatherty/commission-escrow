-- Commission Escrow standalone baseline (Postgres).
-- Faithful conversion of the artifact's SQLite schema (16 tables) plus the
-- standalone additions: media_assets, background_job_runs, sessions.csrf_hash,
-- case-insensitive unique indexes, foreign keys, query indexes.

CREATE TABLE creators (
  id text PRIMARY KEY,
  name text NOT NULL,
  handle text NOT NULL,
  tagline text NOT NULL,
  accent text NOT NULL,
  bio text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  turnaround text NOT NULL,
  prices_json text NOT NULL,
  will_do_json text NOT NULL,
  wont_do_json text NOT NULL,
  portfolio_json text NOT NULL,
  pfp_url text NOT NULL DEFAULT '',
  banner_url text NOT NULL DEFAULT '',
  bg_color text NOT NULL DEFAULT '#fffef9',
  panel_color text NOT NULL DEFAULT '#ffffff',
  accent2 text NOT NULL DEFAULT '#facc15',
  heading_color text NOT NULL DEFAULT '#334155',
  body_color text NOT NULL DEFAULT '#475569',
  bg_image_url text NOT NULL DEFAULT '',
  showcase_url text NOT NULL DEFAULT '',
  portfolio_images_json text NOT NULL DEFAULT '{}',
  quarantined integer NOT NULL DEFAULT 0,
  quarantined_at timestamptz,
  quarantine_note text NOT NULL DEFAULT '',
  portfolio_quarantine_json text NOT NULL DEFAULT '[]',
  payment_methods_json text NOT NULL DEFAULT '[]',
  crypto_wallets_json text NOT NULL DEFAULT '[]',
  verified_only integer NOT NULL DEFAULT 0,
  banner_frame integer NOT NULL DEFAULT 0,
  name_glow integer NOT NULL DEFAULT 0,
  extra_portfolio_tiles integer NOT NULL DEFAULT 0,
  extra_vault_slots integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);

CREATE TABLE creator_categories (
  creator_id text NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  category text NOT NULL,
  PRIMARY KEY (creator_id, category)
);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  username text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  account_type text NOT NULL DEFAULT 'buyer',
  creator_id text,
  role text NOT NULL DEFAULT 'member',
  refund_debt integer NOT NULL DEFAULT 0,
  is_admin integer NOT NULL DEFAULT 0,
  is_banned integer NOT NULL DEFAULT 0,
  credits integer NOT NULL DEFAULT 0,
  verified integer NOT NULL DEFAULT 0,
  verified_at timestamptz,
  lifetime_earned integer NOT NULL DEFAULT 0,
  device_fingerprint text NOT NULL DEFAULT '',
  ban_evasion_flag integer NOT NULL DEFAULT 0,
  perks_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX accounts_email_lower_idx ON accounts (lower(email));
CREATE UNIQUE INDEX accounts_username_lower_idx ON accounts (lower(username));

CREATE TABLE commissions (
  id text PRIMARY KEY,
  creator_id text NOT NULL REFERENCES creators(id),
  buyer_name text NOT NULL,
  title text NOT NULL,
  brief text NOT NULL,
  refs_text text NOT NULL DEFAULT '',
  budget integer NOT NULL,
  price integer NOT NULL,
  kind text NOT NULL DEFAULT 'standard',
  rail text NOT NULL DEFAULT 'reserve',
  status text NOT NULL DEFAULT 'requested',
  deadline timestamptz,
  sketch_approved integer NOT NULL DEFAULT 0,
  revisions_used integer NOT NULL DEFAULT 0,
  revisions_total integer NOT NULL DEFAULT 2,
  delivered_note text NOT NULL DEFAULT '',
  dispute_reason text NOT NULL DEFAULT '',
  counter_price integer,
  blocks_total integer NOT NULL DEFAULT 1,
  blocks_released integer NOT NULL DEFAULT 0,
  block_amount integer NOT NULL DEFAULT 50,
  buyer_account_id text REFERENCES accounts(id),
  credits_held integer NOT NULL DEFAULT 0,
  credits_released integer NOT NULL DEFAULT 0,
  deposit_amount integer NOT NULL DEFAULT 0,
  deposit_confirmed integer NOT NULL DEFAULT 0,
  deposit_confirmed_at timestamptz,
  sketch_image_url text NOT NULL DEFAULT '',
  sketch_submitted_at timestamptz,
  vault_file_url text NOT NULL DEFAULT '',
  vault_preview_url text NOT NULL DEFAULT '',
  vault_file_name text NOT NULL DEFAULT '',
  vault_delivered_at timestamptz,
  balance_confirmed_at timestamptz,
  unlocked_at timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  ghost_released integer NOT NULL DEFAULT 0,
  pay_method text NOT NULL DEFAULT '',
  deposit_tx text NOT NULL DEFAULT '',
  deposit_tx_confirmed integer NOT NULL DEFAULT 0,
  balance_tx text NOT NULL DEFAULT '',
  balance_tx_confirmed integer NOT NULL DEFAULT 0,
  v2 integer NOT NULL DEFAULT 0,
  escalated integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX commissions_buyer_idx ON commissions (buyer_account_id);
CREATE INDEX commissions_creator_idx ON commissions (creator_id);
CREATE INDEX commissions_status_idx ON commissions (status);

CREATE TABLE ledger_entries (
  id serial PRIMARY KEY,
  commission_id text NOT NULL REFERENCES commissions(id),
  label text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  amount integer NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);
CREATE INDEX ledger_commission_idx ON ledger_entries (commission_id);

CREATE TABLE auction_lots (
  id text PRIMARY KEY,
  title text NOT NULL,
  theme text NOT NULL,
  reserve integer NOT NULL,
  current_bid integer NOT NULL DEFAULT 0,
  bidder text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL
);

CREATE TABLE sessions (
  token text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf_hash text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE login_attempts (
  id serial PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX login_attempts_email_time_idx ON login_attempts (email, created_at);

CREATE TABLE posts (
  id text PRIMARY KEY,
  creator_id text NOT NULL REFERENCES creators(id),
  title text NOT NULL,
  body text NOT NULL,
  price_note text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  video_url text NOT NULL DEFAULT '',
  quarantined integer NOT NULL DEFAULT 0,
  quarantined_at timestamptz,
  quarantine_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);
CREATE INDEX posts_creator_time_idx ON posts (creator_id, created_at);

CREATE TABLE post_categories (
  post_id text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  category text NOT NULL,
  PRIMARY KEY (post_id, category)
);

CREATE TABLE auction_items (
  id text PRIMARY KEY,
  lot_id text NOT NULL REFERENCES auction_lots(id),
  creator_name text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL,
  door text NOT NULL,
  shares integer NOT NULL,
  media_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'accepted',
  checklist_json text NOT NULL DEFAULT '{}',
  quarantined integer NOT NULL DEFAULT 0,
  quarantined_at timestamptz,
  quarantine_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);

CREATE TABLE invite_codes (
  id text PRIMARY KEY,
  code text NOT NULL,
  max_uses integer NOT NULL,
  uses_count integer NOT NULL DEFAULT 0,
  created_by text NOT NULL DEFAULT '',
  disabled integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX invite_codes_code_idx ON invite_codes (code);

CREATE TABLE reports (
  id text PRIMARY KEY,
  reporter_account_id text REFERENCES accounts(id) ON DELETE SET NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  item_title text NOT NULL DEFAULT '',
  reason text NOT NULL,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL
);
CREATE INDEX reports_status_time_idx ON reports (status, created_at);

CREATE TABLE moderation_log (
  id serial PRIMARY KEY,
  actor_id text NOT NULL,
  actor_label text NOT NULL DEFAULT '',
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);
CREATE INDEX moderation_log_time_idx ON moderation_log (created_at);

CREATE TABLE strikes (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  note text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);

CREATE TABLE standing_events (
  id serial PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  commission_id text NOT NULL DEFAULT '',
  kind text NOT NULL,
  points integer NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);
CREATE INDEX standing_account_kind_comm_idx ON standing_events (account_id, kind, commission_id);

CREATE TABLE media_assets (
  id text PRIMARY KEY,
  owner_account_id text,
  kind text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  width integer,
  height integer,
  ready integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX media_assets_owner_idx ON media_assets (owner_account_id);

CREATE TABLE background_job_runs (
  id serial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'tick',
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  counts_json text NOT NULL DEFAULT '{}',
  error text NOT NULL DEFAULT ''
);
