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

**Tier 1 — native OAuth integration, build first:**
- Google Drive (Drive API)
- Dropbox (DBX Platform)
- Microsoft OneDrive (Microsoft Graph API)

Each: OAuth2 flow, encrypted refresh token stored server-side (same encryption
pattern as the OpenRouter key), user selects/assigns one target folder per
connected provider.

**Tier 2 — generic WebDAV fallback:**
- One generic WebDAV adapter (endpoint URL + username/password or app token,
  entered manually — no native folder picker, weaker UX than Tier 1)
- Covers Icedrive, Internxt, self-hosted Nextcloud, and similar providers that
  lack a proper third-party write API
- Build only if Tier 1 proves insufficient

**Explicitly excluded:**
- iCloud — no public API for third-party write access to a user's iCloud Drive
- Mega, NordLocker, Internxt (as a *native* integration) — zero-knowledge/client-
  side encryption architecture is incompatible with simple server-side writes;
  Internxt is only in scope via the generic WebDAV fallback, not a native adapter
- IDrive — public docs point to IDrive e2 (S3-compatible object storage), a
  different product from IDrive's consumer backup app; no confirmed general-
  purpose write API found. Do not build against it without confirming current
  docs directly.

Behavior: if a user has a cloud folder configured, new media uploads there
instead of local disk, and only a reference (external file ID/path + provider) is
stored in the DB — doesn't count against the 5GB cap. No folder configured →
falls back to local disk, counts against the cap.

**Priority and per-provider quotas**, if more than one provider is linked:
- User sets an explicit priority order among their linked providers (e.g. Drive
  first, Dropbox second). New media uploads to the highest-priority provider
  with room available.
- Each linked provider can optionally have a user-set quota (in GB), capping
  how much of *that* provider's storage this app is allowed to consume —
  independent of the provider's own account capacity. Left blank = no
  app-imposed cap for that provider.
- If the top-priority provider is at its quota (or an upload fails for a
  provider-side reason), the app falls through to the next provider in
  priority order, and finally to local disk (still subject to the 5GB cap) if
  every linked provider is full or none are configured.
- **Notice banner**: an in-app notification appears when any linked provider
  hits its quota (same notice pattern as the local 3.5GB warning), so the user
  knows uploads have started falling through to a lower-priority provider (or
  to local disk) rather than silently discovering it later.
- Requires tracking bytes used per linked storage account (not just per
  provider type), same denormalized-counter pattern as `users.storage_used_bytes`
  but scoped to the individual `storage_accounts` row — see schema update below.

## Settings / Account Menu

- Edit profile
- OpenRouter API key (update key, view last-4, view credits)
- Spend dashboard (total spend all-time/this month, breakdown by model and by
  chat, computed from `messages.cost_usd`)
- Cloud storage (connect/disconnect Drive, Dropbox, OneDrive, or configure WebDAV;
  set target folder, priority order, and optional quota per provider;
  view local storage used vs 5GB cap)
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
  file_ref, size_bytes, created_at
  -- direction: input = user-uploaded (vision/file attach), output = generated
  -- storage_account_id identifies which specific linked account got the file,
  -- needed for per-account quota enforcement when multiple providers are linked

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

- OpenRouter video generation: confirm whether completion is delivered via
  webhook push or requires client-side polling (`video.generation.completed`
  event was referenced in OpenRouter's docs but the delivery mechanism wasn't
  confirmed in this planning session)
- OpenRouter output URL expiry behavior — confirm per-provider if possible,
  though the build should proceed on the safe assumption (fetch immediately)
  regardless
- IDrive: confirm whether any current API supports third-party write access to
  the consumer product, if you want to revisit adding it later

## Suggested Build Order

1. Auth (signup, login, TOTP enrollment/verify, sessions)
2. Core chat: single-model text chat, OpenRouter key storage, chat CRUD, sidebar
3. Model picker + text modality end-to-end
4. Image modality (Unified Image API)
5. Video modality (async handling — highest complexity, do last among modalities)
6. Local storage accounting + 3.5GB/5GB thresholds
7. Cloud storage: Drive → Dropbox → OneDrive (OAuth flows, folder assignment,
   upload-on-generate)
8. WebDAV fallback (optional, defer until needed)
9. Settings/account menu, credits display, account deletion
