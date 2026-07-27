# Multi-Model AI Chat Client — Project Spec

## Purpose

A BYOK (bring-your-own-key) web-based AI chat client for comparing outputs across
LLMs, image generation models, and video generation models via OpenRouter. Core
use case: personal curiosity / model comparison, not a public product. Multi-user
from day one (friends, invite-only) but not publicized, with room to open up later
without a schema rework.

Comparison is manual: user opens a chat, picks a model, sends a prompt; to compare,
they open another chat (or browser tab) with a different model and paste the same
prompt. No automated fan-out/broadcast — each chat is a normal, independent
conversation with one model.

## Stack

- **Frontend**: React + Vite
- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Deployment**: Existing VPS (Ubuntu 24.04), built via Claude Code CLI

## Auth

- Email (used as username, not for sending mail — no email service anywhere in
  this app) + password (argon2 hashing)
- TOTP as 2nd factor (`otplib`), enrollment via QR code, one-time backup codes
  generated at setup (shown once, hashed at rest) — lets a user recover their own
  2FA lockout without needing you
- **TOTP is not required on every login.** After a successful TOTP verification,
  set a separate long-lived signed httpOnly cookie ("trusted device") marking
  that specific browser as verified for a set period (e.g. 30 days, configurable).
  On subsequent logins, password alone is sufficient if a valid trusted-device
  cookie is present; TOTP is re-required if it's missing, expired, or it's a
  new browser/device. Store trusted-device tokens hashed server-side (not just
  cookie-signed) so they can be individually revoked or all invalidated at once
  (e.g. on password change or admin-forced reset).
- Server-side sessions via httpOnly, secure, sameSite cookies — not JWT in
  localStorage. Session store: Postgres-backed (`connect-pg-simple`) or Redis if
  preferred at build time
- **Account creation is admin-issued, not self-service.** You generate a one-time
  invite token (random string, stored hashed, expiring), share it out-of-band
  (text, in person, whatever), and the recipient uses it once to set their
  email/password and enroll TOTP. No email verification step, no email service
  required anywhere in the app.
- **Recovery is manual by design.** No password-reset email flow. If a user
  loses their password and their TOTP backup codes, you reset them directly via
  DB access on the VPS — see "Manual Account Recovery" below.

## Manual Account Recovery

No email reset flow exists by design. To recover a locked-out user, run these on
the VPS from the `server/` directory (they need the DB env from `.env`). Two
paths: the built-in CLI (preferred — handles argon2 hashing) or raw SQL for the
parts that don't need hashing.

### CLI (preferred) — `scripts/reset-user.js`

```sh
# Reset password only (also revokes all trusted devices):
node scripts/reset-user.js --email user@example.com --password 'NewStrongPass1'

# Reset TOTP only — user re-enrolls a fresh authenticator on next login:
node scripts/reset-user.js --email user@example.com --reset-totp

# Full lockout recovery (new password AND fresh TOTP enrollment):
node scripts/reset-user.js --email user@example.com --password 'NewStrongPass1' --reset-totp

# Grant / revoke admin:
node scripts/reset-user.js --email user@example.com --make-admin
node scripts/reset-user.js --email user@example.com --remove-admin
```

After `--reset-totp`, the user logs in with their password and is sent straight
into TOTP re-enrollment (new QR + new backup codes), then verifies a code to
finish. Any password or TOTP change revokes all of that user's trusted devices.

### Raw SQL (no hashing needed)

Passwords can't be set via raw SQL (argon2 hashing required — use the CLI). But
these work directly in `psql` (`sudo -u postgres psql -d mmchat`):

```sql
-- Force fresh TOTP enrollment on next login (deletes the secret + backup codes):
DELETE FROM totp_secrets WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.com');

-- Revoke all trusted devices (force full re-auth everywhere):
DELETE FROM trusted_devices WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.com');

-- Toggle admin:
UPDATE users SET is_admin = true  WHERE email = 'user@example.com';
UPDATE users SET is_admin = false WHERE email = 'user@example.com';

-- Invalidate a user's live sessions (log them out everywhere):
DELETE FROM sessions
 WHERE (sess ->> 'userId') = (SELECT id::text FROM users WHERE email = 'user@example.com');
```

### First admin (bootstrap)

There's no admin to issue the first invite, so mint one from the CLI (it has DB
access, so it needs no existing admin):

```sh
node scripts/create-invite.js --admin
```

Then open the frontend at the printed `/register?token=…` link to create the
admin account (sets password, enrolls TOTP, shows backup codes once).

## Core Chat UI

- Sidebar: flat list of chats, "new chat" button, collapse/expand toggle
- One chat pane per browser tab/window — no split-pane UI. Comparison happens via
  multiple tabs.
- Each chat has: one model, one modality (text / image / video), one message
  thread
- **User-uploaded input**: text/image-capable chats support attaching a file
  (image, document) to a message as input, not just receiving generated output.
  Uploaded input files count against the same 5GB local cap / cloud-folder
  offload as generated output — see schema update below.
- **Model picker**:
  - Pulls live list from `GET /api/v1/models`, filtered server-side by modality
    via `output_modalities` (`text`, `image`, or `all`). Default (no param)
    returns text models only. Video modality param TBD — see open item below.
  - Client-side filters: text search by name, and modality. A "specialty"
    filter (coding, vision, reasoning, etc.) isn't a structured field on this
    endpoint — approximate it by keyword-matching each model's `description`
    text if you want this; it won't be a clean, guaranteed taxonomy, just a
    best-effort filter.
  - Each entry shows: name, `description` blurb, and pricing (prompt/completion
    cost per token, or image/video pricing where applicable) — all from the
    same `/models` response, always visible, no extra API call.
  - Descriptions sometimes contain embedded markdown links to other model
    pages — strip or render as plain text, don't show raw markdown syntax.
- **Provider routing** (how OpenRouter picks which company actually serves a
  multi-provider model, e.g. Llama/DeepSeek/Mixtral):
  - Sort toggle: price (default) vs. speed/throughput — maps to `provider.sort`
  - Privacy toggle: avoid providers that may log/train on prompt data — maps to
    `provider.data_collection: "deny"` (default `"allow"`)
  - Sent via the `provider` object on the OpenRouter request. Full allow/deny
    provider lists and explicit fallback ordering are out of scope for v1 —
    OpenRouter's automatic fallback behavior is used as-is. Revisit if a
    specific model's provider quality becomes a real problem.
- Open item: confirm whether video models are addressable via
  `output_modalities=video` on this same endpoint, or need to be identified some
  other way, since video generation runs through a separate `/videos` endpoint
  rather than `/chat/completions` or `/images`. Not confirmed during planning —
  verify against current OpenRouter docs during build.

## OpenRouter Integration

| Modality | Endpoint | Notes |
|---|---|---|
| Text | `POST /api/v1/chat/completions` | Streamable |
| Image | `POST /api/v1/images` (Unified Image API) | Standardized request shape across 30+ models |
| Video | `POST /api/v1/videos` | **Asynchronous** — job submitted, then polled or pushed via `video.generation.completed` event. Confirm exact completion mechanism (webhook vs poll) against current OpenRouter docs before building this path. |
| Credits | `GET /api/v1/auth/key` | Uses the user's own key as bearer token; returns rate limit / credit info for that key. This is what powers the "view credits" link in the profile page. |

**Key storage**: user's OpenRouter API key encrypted at rest, AES-256-GCM, server-
side master key (env var to start; consider a secrets manager later). Full key
never returned to client after initial save — display last 4 characters only.
Decrypt only server-side, only at request time. Never logged.

**Output persistence assumption**: OpenRouter-hosted output URLs are NOT assumed
persistent (varies by model/provider). Backend fetches and writes every generated
file (image/video) to storage immediately on completion, regardless of eventual
destination (local disk or linked cloud folder). No lazy-fetch path.

**Error handling**: invalid/revoked key, insufficient credits, and model-
unavailable responses from OpenRouter are normal-path occurrences with BYOK, not
edge cases. Surface the actual OpenRouter error message to the user rather than
a generic failure, and distinguish "your key/credits" problems (user must act,
e.g. top up or fix their key) from "this model/provider" problems (user can just
pick a different model).

**Streaming transport**: text responses stream via Server-Sent Events (SSE), not
WebSockets — matches the one-directional nature of a completion stream and is
simpler to run behind a standard reverse proxy on the VPS than WebSocket upgrade
handling.

**Pending video job reconciliation**: since video generation is async, a chat
with a message in `pending` state (job submitted, not yet complete) re-checks
that job's status against OpenRouter on page load, not just via whatever
completion mechanism fires while the tab is open — covers the case where the
user closed the tab or the completion event was missed.

## Storage

- **Cap**: 5 GB local storage per user
- **Notice**: in-app notification at 3.5 GB used
- **Hard stop**: new local media writes blocked at 5 GB, clear error to user
- Text messages excluded from the cap — negligible size, only media counts
- `users.storage_used_bytes` — denormalized running counter, updated on
  `media_files` insert/delete where `storage_location = 'local'`. Not computed by
  summing on every request.

### Cloud storage linking (offloads from the 5GB cap)

**Google Drive is the one supported cloud provider (v1).** OAuth2 flow, encrypted
refresh token stored server-side (same encryption pattern as the OpenRouter key),
uploads into an app-owned `mmchat` folder in the user's Drive.

Behavior: if a user has Google Drive connected, new generated media uploads there
instead of local disk, and only a reference (external file id + provider) is
stored in the DB — doesn't count against the 5GB cap. Not connected → media saves
to local disk and counts against the cap.

> Additional providers (Dropbox, OneDrive, a generic WebDAV fallback) and
> multi-provider **priority ordering + per-provider quotas** (with per-account
> `bytes_used` tracking) are **deferred** — Google Drive is enough for now. See
> the "## Future updates" section for the full deferred design and the
> provider-exclusion notes.

### Out-of-band deletion & manual verification

Cloud files live in the user's own Google Drive, so the user can delete them
directly (in Drive) without going through this app — a door that doesn't exist
for local disk, where a file can only be removed through the app. When that
happens, our `media_files` row still references a file that's gone. What must
degrade gracefully:

- **Serving**: fetching a since-deleted cloud file returns 404/410 from the
  provider. Render it as "no longer available in your cloud storage" rather than
  a broken thumbnail — and flag the row so we don't keep re-fetching it.
- **Accounting** (future): once per-account `bytes_used` tracking exists (deferred
  — see "## Future updates"), the vanished file's bytes must also stop counting
  toward that account's quota / fallthrough routing. Cloud media isn't byte-
  counted today, so this is currently a no-op.

`media_files` is our local manifest of what should exist where (provider +
external `file_ref` per row), so reconciliation is a walk over that manifest:

- **Lazy detection (automatic, free):** when a serve/fetch of a cloud file
  returns not-found, flag that row unavailable (`media_files.unavailable_at`)
  and stop counting its bytes. No polling — it self-heals whenever the file is
  next accessed.
- **Manual "Verify cloud files" button (settings), not an automatic sweep:**
  walks the connected provider's `media_files` rows, checks each is still
  reachable, and flags the vanished ones (recomputing per-account `bytes_used`
  from the survivors is a future add-on, once byte-counting exists). Chosen over
  a background auto-scan deliberately — each
  check is a per-file network round-trip under the provider's rate limits, so a
  user with a large library would make an auto-sweep slow and quota-hungry. The
  user triggers it (with progress feedback) when a number looks wrong.

**Soft-flag, never hard-delete the row.** A file gone from the provider keeps
its `media_files` row (flagged via `unavailable_at`) — the message history still
references it and `messages.cost_usd` must survive (they still paid OpenRouter to
generate the output even though they later deleted it). The message renders
"output no longer in your cloud storage" with the cost record intact.

Eventual consistency is acceptable: the count may briefly overstate after an
out-of-band delete, then corrects on next access or on manual verify. This
mirrors the local counter's recompute utility (Step 7) — per-file `size_bytes`
is ground truth; the counter is a self-healing cache over it.

## Settings / Account Menu

- Edit profile
- OpenRouter API key (update key, view last-4, view credits)
- Spend dashboard (total spend all-time/this month, breakdown by model and by
  chat, computed from `messages.cost_usd`)
- Cloud storage (connect/disconnect Google Drive; view local storage used vs 5GB
  cap; "verify cloud files" to reconcile stored references against Drive after
  out-of-band deletions)
- Delete account

## Database Schema

```
users
  id, email, password_hash, storage_used_bytes, is_admin, created_at
  -- is_admin: can generate invite_tokens and reset other users' credentials

totp_secrets
  user_id, secret, backup_codes (hashed), verified_at

trusted_devices
  id, user_id, token_hash, created_at, expires_at, last_used_at, user_agent_label
  -- revocable individually (settings) or in bulk (password change, admin reset)

invite_tokens
  id, token_hash, created_by_user_id, used_at, expires_at, created_at, is_admin
  -- admin-generated, single-use, shared out-of-band; replaces self-service signup
  -- is_admin (migration 002): the account created from this invite becomes an
  -- admin. Lets the first admin be bootstrapped through the normal invite flow.

api_keys
  id, user_id, encrypted_key, key_suffix, label, created_at

chats
  id, user_id, title, model_id, modality (text|image|video), created_at, updated_at

messages
  id, chat_id, role, content, content_type, cost_usd (nullable), metadata (jsonb), created_at
  -- cost_usd: computed at generation time from model pricing x actual usage,
  -- set on assistant/output messages only, null on user messages
  -- metadata carries modality-specific state, e.g. video job_id + status while pending

media_files
  id, message_id, direction (input|output),
  storage_location (local|google_drive|dropbox|onedrive|webdav),
  storage_account_id (nullable FK -> storage_accounts.id, set when not local),
  file_ref, size_bytes, unavailable_at (nullable), created_at
  -- direction: input = user-uploaded (vision/file attach), output = generated
  -- storage_account_id identifies which specific linked account got the file,
  -- needed for per-account quota enforcement when multiple providers are linked
  -- unavailable_at: set when a cloud file is found deleted on the provider side
  -- (out-of-band) — via lazy detection on serve or the manual "verify cloud
  -- files" action. The row is kept for history + cost_usd, stops counting toward
  -- bytes_used, and renders "no longer in your cloud storage". Null for local
  -- files (local deletion removes the row outright, see Step 7).

storage_accounts
  id, user_id, provider (google_drive|dropbox|onedrive|webdav),
  encrypted_refresh_token, folder_ref, priority, quota_bytes (nullable),
  bytes_used, connected_at
  -- for webdav: encrypted_refresh_token repurposed for encrypted credentials,
  -- folder_ref holds the endpoint URL + path
  -- priority: lower = tried first when multiple providers are linked
  -- quota_bytes: user-set app-imposed cap for this provider, null = unlimited
  -- bytes_used: denormalized counter, same pattern as users.storage_used_bytes

sessions
  -- managed by connect-pg-simple or equivalent session store, not hand-rolled
```

## Spend Protection (Rate Limiting)

BYOK means each user only burns their own OpenRouter credits — the risk here is
accidental duplicate spend (double-click, retry, reload re-firing a request),
not cross-user abuse. Applies to you as a user too, not just other accounts.

- **Idempotency first.** Frontend disables the submit control while a request
  is in flight. Backend refuses a second generation request against a message
  that already has one pending. This is the primary protection — it stops
  accidental duplicate spend at the source, which a rate limit alone won't
  catch on the first occurrence.
- **Per-user request caps as a backstop**, generous for text, tighter for
  image, tightest for video (e.g. cap on concurrent pending video jobs per
  user, since each one is expensive and long-lived). If deployed under PM2 in
  cluster mode, this counter must live in Postgres or Redis, not in-process
  memory — an in-memory counter won't be consistent across worker processes.
- **Pre-flight balance check** for image/video: check remaining credits via
  `GET /api/v1/auth/key` (already used for the profile page) before firing an
  expensive request, and warn if it would draw down a meaningful share of
  what's left. Informational, not a hard block.
- **Confirmation step before video generation** specifically — cheap to build,
  catches accidental/duplicate submits a disabled button alone might miss.

## Spend Tracking

Distinct from the rate-limiting protections above — this is visibility into
what's actually been spent, not prevention of overspend.

- `messages.cost_usd` — computed and stored at generation time: the model's
  per-token pricing (already pulled from `/models` for the picker) multiplied
  by the actual token usage OpenRouter returns in the response, for text; the
  applicable per-image or per-second rate for image/video. Stored on the
  assistant/output message row.
- This is a self-computed estimate, not pulled from OpenRouter's own billing
  ledger — close enough for personal tracking, but can drift slightly from
  your real balance in edge cases (provider-level caching discounts, batching,
  promotional pricing). OpenRouter's own precise per-request billing is only
  exposed via its Analytics API, which requires a separate management key —
  a different, more privileged credential than the per-user API key this app
  is built around, so it's out of scope here.
- Dashboard (settings, or its own page): total spend (all-time and this
  month), breakdown by model, and breakdown by chat — three views over the
  same `cost_usd` data, just grouped differently.

## Security Checklist

- HTTPS only, enforced
- Argon2 password hashing
- TOTP as 2nd factor at enrollment and on untrusted devices (not every login —
  see trusted-device cookie); backup codes issued once at enrollment
- httpOnly/secure/sameSite session cookies, no tokens in localStorage
- AES-256-GCM encryption at rest for: OpenRouter key, cloud storage refresh
  tokens/credentials
- Rate limiting on login and TOTP verification endpoints
- No secrets in logs or error responses
- CSRF protection on state-changing routes

## Open Items — Verify Before/During Build

- ✅ **RESOLVED (Step 6).** OpenRouter video generation completion: it's
  **asynchronous, polled** — `POST /api/v1/videos` returns `202 {id,
  polling_url, status}`, then `GET /api/v1/videos/{id}` is polled to terminal
  status. A `callback_url` webhook exists but is **not used**. See
  "Implementation Notes & Deviations → Video generation" below.
- ✅ **RESOLVED (Steps 5–6).** Output URL expiry: build proceeds on the safe
  "fetch immediately" assumption for both image and video output (implemented).
- Additional cloud providers (Dropbox / OneDrive / WebDAV / IDrive) are deferred
  — see "## Future updates" for the design and the provider-exclusion notes.

## Suggested Build Order

1. Auth (signup, login, TOTP enrollment/verify, sessions)
2. Core chat: single-model text chat, OpenRouter key storage, chat CRUD, sidebar
3. Model picker + text modality end-to-end
4. Image modality (Unified Image API)
5. Video modality (async handling — highest complexity, do last among modalities)
6. Local storage accounting + 3.5GB/5GB thresholds
7. Cloud storage: Google Drive (OAuth flow, app folder, upload-on-generate,
   out-of-band verify)
8. Settings/account menu, credits display, account deletion

(Additional cloud providers + multi-provider priority/quotas + WebDAV are
deferred — see "## Future updates".)

---

## Future updates

Deferred beyond v1 — Google Drive is enough for now. Captured here so the intent
isn't lost; none of this is built.

### Additional cloud storage providers
- **Dropbox** (DBX Platform) and **Microsoft OneDrive** (Microsoft Graph API) as
  native OAuth integrations, same pattern as Google Drive (OAuth2, encrypted
  refresh token, app folder, upload-on-generate, out-of-band verify).
- **Generic WebDAV fallback** — one adapter (endpoint URL + username/password or
  app token, entered manually; no native folder picker). Covers Icedrive,
  Internxt, self-hosted Nextcloud, and similar providers lacking a proper
  third-party write API.
- The `storage_accounts.provider` enum + `media_files.storage_location` enum
  already allow `dropbox|onedrive|webdav`, so adding a provider is a new provider
  module + routes, not a migration.

**Explicitly excluded** (don't build without re-confirming current docs):
- iCloud — no public API for third-party write access to a user's iCloud Drive.
- Mega, NordLocker, Internxt (as a *native* integration) — zero-knowledge/client-
  side encryption is incompatible with simple server-side writes; Internxt only
  in scope via the generic WebDAV fallback.
- IDrive — public docs point to IDrive e2 (S3-compatible), a different product
  from the consumer backup app; no confirmed general-purpose write API found.

### Multi-provider priority + per-provider quotas
Only relevant once more than one provider can be linked:
- User sets an explicit **priority order** among linked providers; new media
  uploads to the highest-priority one with room.
- Each provider can have a user-set **quota (GB)** capping how much of *that*
  account this app may consume. At quota (or on a provider-side failure), uploads
  **fall through** to the next provider, and finally to local disk (still under
  the 5GB cap).
- **Notice banner** when a provider hits its quota (same pattern as the local
  3.5GB notice), so fallthrough isn't silent.
- Requires **per-account `bytes_used`** tracking (denormalized counter scoped to
  each `storage_accounts` row — columns already exist), maintained on
  upload/delete and re-synced by the "verify cloud files" sweep. This is what the
  out-of-band verify's `bytes_used` recompute (above) plugs into.

---

## Implementation Notes & Deviations (as built through Step 8)

This section records where the **built** app diverges from, clarifies, or adds
to the original spec above. The spec captured intent during planning; these are
the facts discovered during the build. When the two disagree, this section wins
for anything through Step 8.

### Model catalogues — separate endpoints per modality

The "Model Picker" spec assumes one list (`GET /api/v1/models`, filtered by
`output_modalities`). In reality only **text** models come from there:

- **Text** → `GET /api/v1/models` (filtered to text output). *On spec.*
- **Image** → dedicated **`GET /api/v1/images/models`** (~48 models). The main
  `/models` list only tags ~3 models as image-output, so filtering it misses
  almost everything. `output_modalities=image` is **not** how image-gen models
  are found.
- **Video** → dedicated **`GET /api/v1/videos/models`**. `output_modalities=video`
  is **not** a thing; video models are only on this endpoint.

The picker is also **locked to the chat's modality** (no in-picker modality
selector) — a mismatched pick only errors on send, so it isn't offered. The
optional keyword "specialty filter" (coding/vision/reasoning) was **not built**.

### Pricing — source, units, and accuracy

The spec assumes pricing is always in the `/models` response ("no extra API
call"). True for text only:

- **Text**: per-token pricing on `/models`. *On spec.*
- **Video**: `pricing_skus` on `/videos/models`, billed **per video-second**;
  keys carry units and some are in **cents** (e.g.
  `cents_per_video_output_second_480p`). We show the cheapest per-second tier as
  "from $X/sec".
- **Image**: **not in the list response.** Pricing is on a per-model
  sub-endpoint **`GET /api/v1/images/models/{id}/endpoints`** as billable items
  `{billable, unit, cost_usd}`. Units vary — **per image, per megapixel, or per
  token**. This requires **extra per-model calls** (concurrency-limited +
  5-min cached), contradicting the "no extra API call" assumption. Per-token
  models are shown as "metered" (no meaningful per-image figure).
- All picker/chip prices are labeled **estimates** with a "verify on
  openrouter.ai" disclaimer.

### `messages.cost_usd` — prefer OpenRouter's reported cost

The spec describes `cost_usd` as a self-computed estimate. As built we **prefer
OpenRouter's returned `usage.cost`** (the actual per-request charge) for text,
image, and video, and only fall back to a computed estimate when it's absent —
and only when cleanly computable (per-image, not per-MP/per-token). This is more
accurate than the pure-estimate model the spec described.

### Video generation — async, polled, reconciled (no webhook)

- Flow: `POST /api/v1/videos` → `202 {id, polling_url, status}`; the assistant
  message is stored `pending` with `jobId`/`pollingUrl`/`jobStatus` in
  `metadata` and `content_type='video'`. Completion is driven by **polling +
  reconciliation**, never a webhook (a `callback_url` exists but is unused — no
  public callback endpoint behind the reverse proxy).
- Reconcile endpoint re-checks each pending job; on `completed` it fetches
  `unsigned_urls[]` (download requires the bearer key) and persists bytes
  immediately, sets `cost_usd` from `usage.cost`, bumps the storage counter; on
  `failed`/`cancelled`/`expired` it marks the message failed. The client polls
  reconcile every ~12s **and** on chat load.

### Spend protection — how it's enforced

- **One pending generation per chat**: a Postgres **partial unique index**
  (migration `003_pending_generation_guard.sql`) on `messages(chat_id) WHERE
  role='assistant' AND metadata->>'status'='pending'`. Covers image **and**
  video atomically (blocks double-submit / reload re-fire).
- **Concurrent video cap** per user: `MAX_CONCURRENT_VIDEOS` (default 2),
  enforced inside a transaction guarded by a **Postgres advisory lock** to avoid
  races across chats.
- **Pre-flight credit check** via `GET /api/v1/auth/key` surfaced in the video
  **confirmation dialog** (warns if an example 8-second clip would use ≥20% of
  remaining credits). Informational, not a hard block.
- Video submit button stays disabled while a job is **pending in that chat**
  (not just during the brief async submit), including after reload.

### Chat model/type locking + new-chat flow (added, not in original spec)

- A chat's **model is fixed once it has any messages** (UI lock + server 400).
  The initial pick and idempotent same-value writes are still allowed.
- A chat's **type (modality) is fixed once it has messages** (UI lock + server
  400); title edits are still allowed. Changing type on an **empty** chat
  **clears the selected model** (it would otherwise be a mismatch).
- **New-chat flow**: creating a chat opens the name/type editor by default and
  **hides the model picker until the chat's name/type is saved** — set up the
  chat, then pick a model, then send (which locks it).

### Local storage

- Generated **video** output reuses the same local-storage mechanism as images;
  video mime types (mp4/webm/mov/mkv) are handled. `isSupportedImage()` stays
  image-only (uploads are image input only; video is output only).

### Local storage accounting (Step 7)

- **Counter maintenance is now symmetric.** `users.storage_used_bytes` is
  decremented on removal, not just incremented on write. The only removal path is
  **chat delete** (there are no per-message/per-media delete endpoints), handled
  in `deleteChatAndReleaseMedia` (`server/src/storage/accounting.js`): inside one
  transaction it captures the chat's local `file_ref`s + byte total **before** the
  FK cascade wipes the `media_files` rows, deletes the chat, decrements the owner's
  counter with a `GREATEST(0, …)` underflow guard, then unlinks the files from
  disk **after commit** (a failed unlink must not undo a committed delete).
  App-code, not a DB trigger, by choice.
- **New endpoint `GET /api/storage`** → `{ usedBytes, capBytes, noticeBytes,
  atNotice, atCap }`. Not in the original route plan. Reads the counter (no
  per-request summing) and powers both the persistent notice and the settings
  display.
- **Persistent 3.5 GB notice.** The original transient SSE `storageNotice` flag
  (emitted on the text path, never actually read by the client) is superseded by
  a shell-level banner backed by `StorageContext` — fetched on load and on window
  focus, refreshed after each generation/upload/delete. Amber at ≥3.5 GB, red
  "full" at ≥5 GB. The SSE `storageUsed`/`storageNotice` fields are now vestigial.
- **5 GB hard stop unchanged; the Generate button is *not* disabled at the cap.**
  A click is refused **pre-flight** by the server (before any job or spend) with a
  clear "at your 5 GB limit" message — matching the spec's "blocked write with a
  clear message." Plain text (no attachment) is never blocked.
- **Recompute tool: `server/scripts/recompute-storage.js`** (CLI, not an admin
  route) — resets each user's counter to the true sum of their local
  `media_files.size_bytes`. `--dry-run` reports drift, `--email` scopes to one
  user, no args does all. Repairs the drift left by pre-Step-7 increment-only
  builds. The counter is a self-healing cache; per-file `size_bytes` is truth.
- **Orphaned disk files + sweep tool.** Orphans (files on disk with no
  `media_files` row) can arise from a crash mid-write (bytes written, DB row never
  committed) or a failed post-commit unlink — and pre-Step-7 deletes left some.
  The normal delete path no longer creates them, and **`recompute-storage.js
  --sweep-orphans`** cleans up any that occur: it removes local files under
  `storageDir/<userId>/` that no local `media_files` row references **and** that
  are older than 5 minutes (the age guard means an in-flight write whose row
  hasn't committed is never swept out from under an active generation). Combine
  with `--dry-run` to preview, `--email` to scope to one user. Orphans are
  untracked, so the sweep never touches the counter. This is the on-disk sibling
  of the Step 8 cloud "verify" reconciliation (`findOrphanFiles` /
  `deleteOrphanFiles` in `server/src/storage/accounting.js`).
- **No schema migration** was needed for Step 7 (pure app logic;
  `media_files.unavailable_at` in the schema block is a Step 8 addition, not yet
  migrated).

### Cloud storage — Google Drive (Step 8)

- **Raw REST over `fetch`, no `googleapis` SDK** — matches the OpenRouter client
  style, keeps deps light, and lets the Google base URLs be pointed at a mock in
  tests (`GOOGLE_AUTH_BASE` / `GOOGLE_OAUTH_BASE` / `GOOGLE_API_BASE`).
  `server/src/storage/providers/googleDrive.js`.
- **Scope `drive.file` + app-created folder, not the Google Picker.** Least
  privilege (the app only ever sees files it creates, so no Google security
  review is triggered). On connect the app reuses (or creates) its own `mmchat`
  folder at the Drive root and uploads into it — reconnect finds the existing
  folder by name via `files.list` (which under `drive.file` only returns files
  this app created, so it can't match an unrelated user folder) rather than
  spawning duplicates. This is the "reasonable folder assignment" the spec allows
  in place of a native picker. The user can't currently target an arbitrary
  pre-existing folder (a `drive.file` limitation); revisit with the Picker if
  needed.
- **OAuth is server-side authorization-code with `access_type=offline` +
  `prompt=consent`** (forces a refresh_token every time). Refresh token stored
  **encrypted** (same AES-256-GCM helper as the OpenRouter key); short-lived
  access tokens are derived on demand and cached in-process
  (`storage/accounts.js`). Endpoints: `GET /api/storage/google/connect` (302 →
  Google, CSRF `state` in session), `GET /api/storage/google/callback`,
  `DELETE /api/storage/google`, `GET /api/storage/providers`,
  `POST /api/storage/verify`.
- **Config / env (all optional):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `PUBLIC_BASE_URL` (builds the redirect URI `…/api/storage/google/callback`). If
  unset, Drive simply isn't offered and everything stays local.
- **Migration 004** adds `media_files.unavailable_at` (out-of-band flag) **and**
  `media_files.content_type` (a cloud `file_ref` is an opaque Drive id with no
  extension to infer MIME from — local rows still fall back to extension), plus a
  `storage_accounts (user_id, provider)` UNIQUE so reconnect is an idempotent
  upsert.
- **Only generation output routes to cloud this pass; uploaded vision *input*
  stays local.** The Step 8 prompt scoped cloud offload to generated media; a
  shared `storage/output.js` (`resolveOutputTarget` / `persistGeneratedOutput`)
  now backs both image + video generation and decides cloud-vs-local in one
  place. Cloud writes record only the external reference and **do not** touch
  `users.storage_used_bytes`; the 5 GB pre-flight cap is skipped when the target
  is cloud. Input attachments could be folded in later.
- **Serving cloud media** (`/api/media/:id`) streams the file down from Drive
  with a fresh access token. Out-of-band handling: a Drive **404 → set
  `unavailable_at` → 410**; an already-flagged row 410s without re-fetching
  (lazy detection). A cloud row whose account was **disconnected** (FK set the
  `storage_account_id` NULL) also 410s ("no longer connected"). The client
  renders a **placeholder** for `unavailable` attachments and has an `onError`
  fallback that swaps a broken img/video for the same placeholder.
- **"Verify cloud files"** (`POST /api/storage/verify`, button in Settings) walks
  the user's still-available Drive media and flags any the provider reports gone
  (404 or trashed). **Soft-flag only** — rows are kept so history + `cost_usd`
  survive. Per-account `bytes_used` recompute is **deferred** (Future updates) —
  no cloud byte counter exists yet.
- **Disconnect** revokes at Google (best-effort) and drops the `storage_accounts`
  row. The FK (`ON DELETE SET NULL`) nulls `storage_account_id` on the user's
  existing cloud media, which then serve as the "unavailable" placeholder while
  disconnected. Files in the user's Drive are never deleted.
- **Reconnect re-adopts orphaned media.** `saveAccount` re-links the user's
  same-provider, NULL-account, not-yet-flagged `media_files` rows to the new
  account — so reconnecting (the same Google account) restores access to
  previously-generated files instead of leaving them stuck on the placeholder.
  If a *different* account is connected, files it can't reach just flag
  unavailable on the next serve, so the re-link is safe either way. (Without
  this, disconnect→reconnect would orphan all prior cloud media permanently.)
- **Chat delete leaves cloud files in Drive (deliberate — not a bug).** Deleting
  a chat removes its DB rows (cascade) and unlinks its **local** files from disk +
  decrements the counter (Step 7), but **does not delete cloud files** — they
  persist in the user's `mmchat` Drive folder. Intentional: the folder doubles as
  a **media library** that survives chat cleanup, so a user who never copied
  media out of the cloud folder doesn't lose it when they tidy up old chats.
  Cloud cleanup is the user's to do (in their own Drive). This local-deleted /
  cloud-kept asymmetry is by design; account deletion (Step 11) likewise leaves
  cloud files untouched.
- **Media serve caching**: cloud 200s use a short `max-age=60, must-revalidate`
  (files can vanish out-of-band, so don't pin them long); every error/410/404
  response sets `Cache-Control: no-store` so a transient failure (e.g. a briefly
  disconnected provider) can't be heuristically cached and keep showing the
  placeholder after the file is reachable again. Local 200s stay long-immutable.
- **Message ordering**: a generated turn inserts the user prompt + assistant
  message in one transaction, so both would share `now()` (the transaction
  timestamp) and sort ambiguously. Fixed by writing `created_at` with
  `clock_timestamp()` (distinct per statement) and ordering
  `created_at ASC, (role <> 'user') ASC` so the prompt always precedes its output.
