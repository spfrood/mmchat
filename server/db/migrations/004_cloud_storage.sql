-- Step 8 (cloud storage — Google Drive first). Adds the columns the cloud path
-- needs on media_files, and pins one storage_accounts row per (user, provider).

-- unavailable_at: set when a cloud file is found deleted on the provider side
--   (out-of-band) — via lazy detection when we try to serve it, or the manual
--   "verify cloud files" action. The row is KEPT (message history + cost_usd must
--   survive) but stops being served and (Step 9) stops counting bytes. Always
--   NULL for local files, whose deletion removes the row outright (Step 7).
ALTER TABLE media_files ADD COLUMN unavailable_at timestamptz;

-- content_type: the file's MIME type recorded at write time. Local refs carry an
--   extension we can infer from, but a cloud file_ref is an opaque provider file
--   id with no extension — so we store the type explicitly (used to serve the
--   right Content-Type and to pick <img> vs <video> in the client). Existing
--   local rows stay NULL and fall back to extension-based detection.
ALTER TABLE media_files ADD COLUMN content_type text;

-- One linked account per provider per user (Step 8 connects Drive once; reconnect
-- is an idempotent upsert). Step 9's priority ordering is across providers.
ALTER TABLE storage_accounts
  ADD CONSTRAINT uq_storage_account_user_provider UNIQUE (user_id, provider);
