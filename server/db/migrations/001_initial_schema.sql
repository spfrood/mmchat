-- ─────────────────────────────────────────────────────────────────────────
-- 001_initial_schema
-- Full database schema from chat_project_bible.md → "Database Schema".
-- Tables are created in dependency order (referenced tables first).
-- Enum-like columns use TEXT + CHECK constraints (flexible across migrations).
-- ─────────────────────────────────────────────────────────────────────────
-- gen_random_uuid() is built into PostgreSQL core since v13 (Ubuntu 24.04
-- ships v16), so no pgcrypto extension — and thus no superuser — is required
-- to run this migration as the unprivileged mmchat role.
-- ─────────────────────────────────────────────────────────────────────────

-- ── users ────────────────────────────────────────────────────────────────
-- is_admin: can generate invite_tokens and reset other users' credentials.
CREATE TABLE users (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text        NOT NULL UNIQUE,
  password_hash      text        NOT NULL,
  storage_used_bytes bigint      NOT NULL DEFAULT 0,
  is_admin           boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ── totp_secrets (one per user) ──────────────────────────────────────────
-- backup_codes: array of *hashed* one-time codes, shown once at enrollment.
CREATE TABLE totp_secrets (
  user_id      uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret       text        NOT NULL,
  backup_codes jsonb       NOT NULL DEFAULT '[]'::jsonb,
  verified_at  timestamptz
);

-- ── trusted_devices ──────────────────────────────────────────────────────
-- Marks a specific browser as TOTP-verified for a period. Token stored hashed
-- so it can be revoked individually (settings) or in bulk (password change,
-- admin reset).
CREATE TABLE trusted_devices (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       text        NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  last_used_at     timestamptz,
  user_agent_label text
);
CREATE INDEX idx_trusted_devices_user ON trusted_devices(user_id);

-- ── invite_tokens ────────────────────────────────────────────────────────
-- Admin-generated, single-use, shared out-of-band; replaces self-service signup.
CREATE TABLE invite_tokens (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         text        NOT NULL UNIQUE,
  created_by_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  used_at            timestamptz,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ── api_keys ─────────────────────────────────────────────────────────────
-- encrypted_key: AES-256-GCM ciphertext of the user's OpenRouter key.
-- key_suffix: last 4 chars, the only part ever shown back to the client.
CREATE TABLE api_keys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_key text        NOT NULL,
  key_suffix    text        NOT NULL,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- ── chats ────────────────────────────────────────────────────────────────
-- One model, one modality, one message thread per chat.
CREATE TABLE chats (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text,
  model_id   text,
  modality   text        NOT NULL CHECK (modality IN ('text', 'image', 'video')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chats_user ON chats(user_id);

-- ── messages ─────────────────────────────────────────────────────────────
-- cost_usd: computed at generation time; set on assistant/output rows only.
-- metadata: modality-specific state, e.g. video job_id + status while pending.
CREATE TABLE messages (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      uuid          NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role         text          NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content      text,
  content_type text,
  cost_usd     numeric(12, 6),
  metadata     jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_chat ON messages(chat_id);

-- ── storage_accounts ─────────────────────────────────────────────────────
-- Linked cloud storage. Defined before media_files (which references it).
-- For webdav: encrypted_refresh_token holds encrypted credentials;
-- folder_ref holds the endpoint URL + path.
-- priority: lower = tried first. quota_bytes null = unlimited (app-imposed).
-- bytes_used: denormalized counter, same pattern as users.storage_used_bytes.
CREATE TABLE storage_accounts (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                text        NOT NULL CHECK (provider IN ('google_drive', 'dropbox', 'onedrive', 'webdav')),
  encrypted_refresh_token text        NOT NULL,
  folder_ref              text,
  priority                integer     NOT NULL DEFAULT 0,
  quota_bytes             bigint,
  bytes_used              bigint      NOT NULL DEFAULT 0,
  connected_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_storage_accounts_user ON storage_accounts(user_id);

-- ── media_files ──────────────────────────────────────────────────────────
-- direction: input = user-uploaded (vision/file attach), output = generated.
-- storage_account_id: which linked account got the file (null = local disk),
-- needed for per-account quota enforcement.
CREATE TABLE media_files (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id         uuid        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  direction          text        NOT NULL CHECK (direction IN ('input', 'output')),
  storage_location   text        NOT NULL CHECK (storage_location IN ('local', 'google_drive', 'dropbox', 'onedrive', 'webdav')),
  storage_account_id uuid        REFERENCES storage_accounts(id) ON DELETE SET NULL,
  file_ref           text        NOT NULL,
  size_bytes         bigint      NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_files_message ON media_files(message_id);
CREATE INDEX idx_media_files_storage_account ON media_files(storage_account_id);

-- ── sessions ─────────────────────────────────────────────────────────────
-- Schema matches connect-pg-simple's expected table (configure the store with
-- tableName: 'sessions'). Server-side session store, not hand-rolled.
CREATE TABLE sessions (
  sid    varchar      NOT NULL COLLATE "default",
  sess   json         NOT NULL,
  expire timestamp(6) NOT NULL,
  CONSTRAINT sessions_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX idx_sessions_expire ON sessions(expire);
