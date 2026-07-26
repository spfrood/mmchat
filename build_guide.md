# Build & Testing Guide — Multi-Model AI Chat Client

How to use this document: work through the steps in order. Each step has a
prompt to give Claude Code and a manual test checklist. **Do not move to the
next step until you've personally tested the current one and confirmed it
works.** Every prompt below includes an explicit instruction telling Claude
Code to stop and wait for your confirmation — this is intentional and should
not be removed, even if it seems slower. Building auth wrong and finding out
five steps later, after everything else was built on top of it, costs far more
time than testing after each step.

Before Step 0, make sure `chat_project_bible.md` is in the project directory —
every prompt tells Claude Code to read it first, since it's the source of
truth for schema, security requirements, and scope decisions.

---

## Step 0 — Project Scaffolding

**Goal**: repo structure, dev environment, and an empty-but-running app —
nothing functional yet, just proof the stack boots.

**Prompt:**
> Read `chat_project_bible.md` in this directory — it's the full spec for
> what we're building. Don't build any features yet. Set up the project
> scaffolding only:
> - React + Vite frontend, Node.js + Express backend, as two directories in
>   this repo (or a monorepo structure if you prefer — your call).
> - PostgreSQL connection config using environment variables (`.env`, with a
>   `.env.example` committed instead of the real one).
> - Create the full database schema from the bible's "Database Schema"
>   section as a migration (use whatever migration tool you think fits —
>   `node-pg-migrate`, raw SQL files, or similar).
> - A basic Express server that starts and responds to a health-check route,
>   and a basic Vite dev server that renders a placeholder page.
> - `.gitignore` covering `node_modules`, `.env`, and build output.
>
> When this is done, stop and tell me how to start both the frontend and
> backend locally, and how to run the migration. Wait for me to confirm
> everything runs before doing anything else.

**You test:**
- [ ] Backend starts without errors, health-check route responds
- [ ] Frontend dev server starts, placeholder page loads in browser
- [ ] Migration runs cleanly against a local/dev Postgres instance
- [ ] All tables from the schema exist (`\dt` in `psql`)

**Do not proceed to Step 1 until all four are confirmed.**

---

## Step 1 — Auth

**Goal**: invite-based account creation, password + TOTP login, trusted-device
cookie, admin invite generation. No chat functionality yet.

**Prompt:**
> Read `chat_project_bible.md`, specifically the "Auth" section and the
> `users`, `totp_secrets`, `trusted_devices`, and `invite_tokens` tables in
> the schema. Build:
> - Admin-issued invite token generation (a way for an `is_admin` user to
>   create a one-time invite token — a CLI script or a minimal admin route is
>   fine, doesn't need a polished UI yet).
> - Account creation via invite token: set email + password (argon2 hash),
>   enroll TOTP (QR code + secret), generate and display one-time backup
>   codes (hashed at rest, shown once).
> - Login: email + password, then TOTP challenge if no valid trusted-device
>   cookie is present, skip TOTP if one is.
> - Trusted-device cookie: signed, httpOnly, secure, set after successful
>   TOTP verification, token hashed server-side, configurable expiry
>   (default 30 days).
> - Server-side sessions via httpOnly/secure/sameSite cookies (Postgres-backed
>   session store).
> - Manual recovery: document in the bible the exact SQL/CLI commands to
>   reset a locked-out user's password and TOTP directly via DB access.
>
> No chat UI yet — a simple login/signup page and a "logged in, nothing here
> yet" placeholder after auth succeeds is enough. When done, stop and tell me
> how to generate my first (admin) invite token and test the full flow. Wait
> for my confirmation before starting Step 2.

**You test:**
- [ ] Generate an invite token, use it to create an account
- [ ] TOTP QR code scans correctly in an authenticator app, code verifies
- [ ] Backup codes are shown once and work if you deliberately use one instead of TOTP
- [ ] Log out, log back in — TOTP required (no trusted-device cookie yet)
- [ ] After TOTP success, log out and back in again — TOTP skipped (trusted-device cookie present)
- [ ] Clear cookies / use a different browser — TOTP required again
- [ ] Try an expired or already-used invite token — rejected
- [ ] Confirm the documented manual-recovery commands actually work against a test account

**Do not proceed to Step 2 until all of the above are confirmed.**

---

## Step 2 — Core Chat Shell

**Goal**: sidebar, chat CRUD, OpenRouter API key storage — the frame the rest
of the app fills in. No actual model calls yet.

**Prompt:**
> Read `chat_project_bible.md`, specifically "Core Chat UI" (sidebar/layout
> only, ignore model picker details for now), the OpenRouter key storage
> requirements under "OpenRouter Integration," and the `chats`, `messages`,
> and `api_keys` tables. Build:
> - Sidebar: flat list of the logged-in user's chats, "new chat" button,
>   collapse/expand toggle.
> - Chat CRUD: create, rename, delete a chat. A chat has a title, model_id,
>   and modality, but don't wire up real model calls yet — a chat can exist
>   with no messages.
> - Settings page (or a simple placeholder route) where the user pastes their
>   OpenRouter API key. Encrypt at rest with AES-256-GCM using a server-side
>   master key from an env var. Never return the full key to the client after
>   save — only show the last 4 characters.
>
> When done, stop and tell me how to test key storage and chat CRUD. Wait for
> my confirmation before starting Step 3.

**You test:**
- [ ] Create several chats, confirm they appear in the sidebar
- [ ] Rename and delete a chat
- [ ] Sidebar collapse/expand works
- [ ] Save an OpenRouter API key, refresh the page — only last 4 characters shown, never the full key
- [ ] Check the database directly — confirm the stored key is encrypted, not plaintext
- [ ] Update the key to a different value, confirm it actually changes

**Do not proceed to Step 3 until all of the above are confirmed.**

---

## Step 3 — Model Picker + Text Modality

**Goal**: real, working text chat against OpenRouter. This is the core of the
app — take your time testing this one.

**Prompt:**
> Read `chat_project_bible.md`, specifically "Core Chat UI" (model picker,
> provider routing) and the "OpenRouter Integration" section for the text row
> and the streaming/error-handling notes. Build:
> - Model picker: live list from `GET /api/v1/models`, filtered by
>   `output_modalities=text` by default. Show each model's name, description
>   (strip markdown links, render as plain text), and pricing. Add a text
>   search filter and a modality filter.
> - Provider routing controls: a sort toggle (price vs. speed) and a privacy
>   toggle (avoid data-logging providers), mapped to the `provider` object's
>   `sort` and `data_collection` fields on the request.
> - Send a message: `POST /api/v1/chat/completions`, streamed via
>   Server-Sent Events, rendered incrementally in the chat pane as it arrives.
> - Store both the user message and the assistant response in the `messages`
>   table.
> - Error handling: surface OpenRouter's actual error message for invalid/
>   revoked key, insufficient credits, or model-unavailable responses —
>   distinguish "fix your key/credits" errors from "try a different model"
>   errors in how they're displayed.
>
> When done, stop and tell me how to test this end-to-end with a real
> OpenRouter key. Wait for my confirmation before starting Step 4.

**As built (deviations):** the model picker is **locked to the chat's modality**
(the in-picker modality selector was removed — a mismatch only errors on send);
the optional "specialty filter" was not built; all displayed prices are labeled
**estimates** ("verify on openrouter.ai"). A chat's **model locks once it has
messages** (UI + server). See the bible's "Implementation Notes & Deviations".

**You test:**
- [ ] Model picker loads real models, search and modality filter work
- [ ] Pricing displayed matches what's on openrouter.ai for a couple of models you spot-check
- [ ] Send a message to a real model, response streams in visibly (not all-at-once)
- [ ] Message history persists after a page refresh
- [ ] Toggle the sort/privacy provider routing options and confirm (via network tab) the `provider` object is actually being sent
- [ ] Deliberately use an invalid API key — confirm the error message is clear and correctly identified as a "key" problem
- [ ] Deliberately pick an unusual/rare model that might be unavailable — confirm the error is identified as a "model" problem, not a generic failure
- [ ] Open two tabs, two different chats, two different models — confirm both work independently (this is your core comparison workflow — make sure it's actually good to use)

**Do not proceed to Step 4 until all of the above are confirmed.**

---

## Step 4 — User-Uploaded Input

**Goal**: attach an image/file to a message for vision-capable models.

**Prompt:**
> Read `chat_project_bible.md` — the "User-uploaded input" note under "Core
> Chat UI" and the `media_files` table (`direction = 'input'`). Build:
> - File/image attach control on the message composer, for models that
>   support vision input.
> - Uploaded files get written to local storage (same mechanism you'll expand
>   in Step 7 for generated output) and referenced via `media_files` with
>   `direction = 'input'`.
> - Attached images get sent to OpenRouter as part of the message content per
>   the model's expected multimodal input format.
>
> When done, stop and tell me how to test this. Wait for my confirmation
> before starting Step 5.

**You test:**
- [ ] Attach an image to a message, send it to a vision-capable model, confirm the model actually "sees" it (ask it to describe the image)
- [ ] Confirm the uploaded file is written to disk and referenced in `media_files` with the correct direction
- [ ] Try attaching to a non-vision model — confirm this fails gracefully, not silently

**Do not proceed to Step 5 until all of the above are confirmed.**

---

## Step 5 — Image Modality

**Goal**: image generation via OpenRouter's Unified Image API.

**Prompt:**
> Read `chat_project_bible.md` — the image row in "OpenRouter Integration"
> and the output-persistence assumption (fetch and store immediately, don't
> assume OpenRouter's URL is durable). Build:
> - Image modality chat: `POST /api/v1/images`, model picker filtered to
>   `output_modalities=image`.
> - On generation completion, immediately fetch the image bytes and write to
>   local storage, referenced via `media_files` with `direction = 'output'`.
> - Display the generated image inline in the chat thread.
> - Apply the idempotency guard from the "Spend Protection" section: disable
>   submit while a generation is in flight, refuse a duplicate request against
>   the same pending message.
>
> When done, stop and tell me how to test this. Wait for my confirmation
> before starting Step 6.

**As built (deviations):** image models come from a dedicated
`GET /api/v1/images/models` endpoint (~48 models), **not** `output_modalities=image`
on `/models`. Pricing is **not** in that list — it's fetched per-model from
`GET /api/v1/images/models/{id}/endpoints`, with units that vary (per image /
per megapixel / per token). See the bible's "Implementation Notes & Deviations".

**You test:**
- [ ] Generate an image from a real prompt, confirm it renders in the chat
- [ ] Confirm the file actually exists on disk, not just a link to OpenRouter's URL
- [ ] Double-click submit rapidly — confirm only one generation fires, not two
- [ ] Refresh the page mid-generation (if timing allows) — confirm it doesn't silently duplicate the request
- [ ] Try an image model with a deliberately bad prompt or invalid key — confirm error handling matches Step 3's pattern

**Do not proceed to Step 6 until all of the above are confirmed.**

---

## Step 6 — Video Modality

**Goal**: async video generation — highest complexity, most expensive, most
in need of careful testing given real spend is involved.

**Prompt:**
> Read `chat_project_bible.md` — the video row in "OpenRouter Integration,"
> the pending-video-job reconciliation note, and the full "Spend Protection"
> section. Confirm current OpenRouter docs for the exact completion delivery
> mechanism (webhook vs. polling) before implementing — this was an open item
> in planning, not confirmed. Build:
> - Video modality chat: `POST /api/v1/videos`, model picker filtered
>   appropriately (confirm against current docs whether `output_modalities`
>   supports a video value, or if video models need to be identified another
>   way).
> - Async job handling: message stored in a `pending` state with the job ID
>   in `metadata`, updated to `complete` (with the fetched/stored file) once
>   the job finishes.
> - Reconciliation: on chat load, any message still in `pending` state gets
>   its job status re-checked against OpenRouter, not just relying on
>   whatever live completion mechanism you implemented.
> - Spend protection specific to video: a cap on concurrent pending video
>   jobs per user, a pre-flight credit balance check via `GET /api/v1/auth/key`
>   with a warning if the generation would use a meaningful share of what's
>   left, and a confirmation dialog before submitting.
>
> When done, stop and tell me exactly what you confirmed about the completion
> mechanism, and how to test this. Wait for my confirmation before starting
> Step 7 — this step involves real spend, so take your time testing it.

**As built (deviations):** video is **async/polled** — `POST /api/v1/videos` →
`202 {id, polling_url, status}`, polled via `GET /api/v1/videos/{id}`; the
`callback_url` webhook is **not** used (polling + on-load reconciliation instead).
Video models come from `GET /api/v1/videos/models` (**not** `output_modalities=video`);
pricing is `pricing_skus` per **video-second** (some keys in cents). Concurrent-video
cap = `MAX_CONCURRENT_VIDEOS` (default 2). See the bible's "Implementation Notes &
Deviations".

**You test:**
- [ ] Generate a video, confirm the confirmation dialog appears first
- [ ] Confirm the job shows a clear "pending/processing" state, not a blank/broken UI, while waiting
- [ ] Close the tab mid-generation, reopen the chat later — confirm the job status reconciles correctly (either still pending or completed, not lost)
- [ ] Confirm the finished video file is written to local storage, not just linked to OpenRouter
- [ ] Try to submit a second video job while one is still pending — confirm the concurrent-job cap actually blocks or warns as designed
- [ ] Check that the balance warning appears when credits are low (may need to test with a near-empty test key)
- [ ] Confirm no duplicate jobs were created anywhere in this testing — check the OpenRouter dashboard/usage directly, not just your app's UI

**Do not proceed to Step 7 until all of the above are confirmed — this is the
step most likely to cost you real money if something's wrong, verify
carefully.**

---

## Step 7 — Local Storage Accounting

**Goal**: finish local storage accounting. The write-side counter and 5 GB hard
cap already exist (built incrementally across Steps 4–6); this step adds the
missing **decrement on delete**, the **3.5 GB notice**, and the **settings
display** — and reconciles any counter drift the missing decrement caused.

**Prompt:**
> Read `chat_project_bible.md` — the "Storage" section (local cap portion only,
> not cloud linking yet) and the "Implementation Notes & Deviations → Local
> storage" note.
>
> **Already built (do NOT rebuild):** `users.storage_used_bytes` is incremented
> and the 5 GB hard cap is pre-flight-enforced on all three local write paths —
> image-input uploads, image generation, and video generation. `NOTICE_LOCAL_BYTES`
> (3.5 GB) and `MAX_LOCAL_BYTES` (5 GB) already exist in config.
>
> Build the missing pieces:
> - **Decrement the counter on delete.** Nothing currently decreases
>   `storage_used_bytes`, so deleting a chat (which cascades `media_files` via FK)
>   leaves the counter overstated. Make every path that removes local
>   `media_files` rows also subtract their `size_bytes` from the owner's counter —
>   chat delete, plus any message/media delete — for `storage_location = 'local'`
>   only. FK cascade won't run app code, so handle this explicitly (sum the
>   affected rows and decrement in the same transaction, or a DB trigger — your
>   call), and delete the underlying files from disk too.
> - **Reconcile existing drift.** Provide a one-off recompute (CLI script or
>   admin route) that resets each user's `storage_used_bytes` to the true sum of
>   their local `media_files.size_bytes` — earlier testing likely already skewed
>   counters given the missing decrement.
> - **3.5 GB notice — persistent, on every path.** Today a transient
>   `storageNotice` flag is emitted only on the text-upload SSE path. Replace it
>   with a consistent in-app notification shown whenever a user is at or above
>   3.5 GB, regardless of how they got there (upload / image / video), and
>   visible **on load** — not just in the response to the write that crossed it.
> - **Settings storage-used display**: used vs. 5 GB cap (bar + "X.X GB of 5 GB"),
>   reading the counter.
> - Leave the existing 5 GB hard stop as-is (blocked writes with a clear message,
>   text/existing chats still usable) — just confirm it still holds after the above.
>
> When done, stop and tell me how to test threshold behavior without actually
> generating 5 GB of real media. Wait for my confirmation before starting Step 8.

**As built (deviations):** decrement + disk-unlink on delete is app-code in
`deleteChatAndReleaseMedia` (captures local refs before the FK cascade, unlinks
after commit); **chat delete is the only removal path** (no per-message/media
delete endpoints). A new **`GET /api/storage`** endpoint backs a persistent
shell banner (`StorageContext`, fetched on load + window focus), replacing the
unused transient SSE flag. The Generate button isn't disabled at the cap — the
click is refused pre-flight with a clear message. Recompute is a CLI
(`scripts/recompute-storage.js`; `--dry-run`/`--email`/`--sweep-orphans`). **No
schema migration.** `--sweep-orphans` removes untracked, >5-min-old files left on
disk by a crash mid-write or pre-Step-7 deletes (the age guard spares in-flight
writes); the normal delete path creates no new orphans. See the bible's
"Implementation Notes & Deviations → Local storage accounting (Step 7)".

**You test:**
- [ ] Storage-used display in settings matches reality (sum of actual file sizes on disk for that user)
- [ ] Artificially push a test account's counter near 3.5GB — confirm the notice appears, and still appears after a page reload (not just once, right after a write)
- [ ] Push past 5GB — confirm new generations/uploads are blocked with a clear message, and existing chats/text still work normally
- [ ] Delete some media **and** delete a whole chat that has media — confirm the counter decreases by the right amount, the files are gone from disk, and the block lifts appropriately
- [ ] Run the reconcile/recompute against an account with a deliberately-skewed counter — confirm it resets to the true on-disk total
- [ ] Run `--sweep-orphans --dry-run`, then `--sweep-orphans` — confirm it lists and removes untracked files left on disk while leaving tracked files intact

**Do not proceed to Step 8 until all of the above are confirmed.**

---

## Step 8 — Cloud Storage: Google Drive → Dropbox → OneDrive

**Goal**: OAuth linking and folder assignment for each Tier 1 provider, one
at a time. Test each provider fully before starting the next — don't build
all three and then test.

**Prompt (repeat once per provider — Drive first, then Dropbox, then OneDrive):**
> Read `chat_project_bible.md` — the "Cloud storage linking" section and the
> `storage_accounts` table. Build the [Google Drive / Dropbox / OneDrive]
> integration only (not the other two, even if you're doing this prompt a
> second or third time — one provider per pass):
> - OAuth2 connect/disconnect flow from the settings page.
> - Encrypted refresh token storage (same AES-256-GCM pattern as the
>   OpenRouter key).
> - Folder selection/assignment (native picker if the provider's SDK
>   supports it, otherwise a reasonable manual entry).
> - On generation (image/video), if this provider is connected and a folder
>   is assigned, upload there instead of local disk, store only the external
>   reference in `media_files`, and don't count it against the 5GB cap.
> - Handle out-of-band deletion (bible: "Out-of-band deletion & manual
>   verification"). A cloud file the user later deletes directly in the provider
>   returns not-found when we serve it — flag that `media_files` row
>   (`unavailable_at`), render "no longer in your cloud storage" instead of a
>   broken image, and stop re-fetching it (lazy detection). Add a manual "Verify
>   cloud files" button in settings that walks this provider's `media_files`
>   rows, checks each is still reachable, and flags the vanished ones. Keep the
>   rows (history + `cost_usd` must survive) — soft-flag, never hard-delete.
>   (Recomputing a per-account byte counter comes in Step 9 — there's no
>   `bytes_used` yet at this step.)
>
> When done, stop and tell me how to test the full connect → generate →
> verify-in-cloud-folder → disconnect flow for this provider specifically.
> Wait for my confirmation before moving to the next provider.

**You test, per provider:**
- [ ] Connect flow completes, folder can be selected/assigned
- [ ] Generate an image or video with this provider connected — confirm the file actually lands in the correct cloud folder
- [ ] Confirm this generation does NOT count against the local 5GB cap
- [ ] Delete a file directly in the cloud provider (out-of-band), then reload the chat — confirm it renders "no longer in your cloud storage", not a broken image or a crash
- [ ] Run "Verify cloud files" — confirm the out-of-band-deleted file gets flagged and stops showing as present, while its message + cost record remain
- [ ] Disconnect the provider — confirm past references still show correctly (or degrade gracefully) and new generations fall back to local disk
- [ ] Reconnect — confirm it doesn't break anything or duplicate stored accounts

**Do not proceed to the next provider (or to Step 9) until the current one is
fully confirmed.**

---

## Step 9 — Cloud Storage Priority & Quotas

**Goal**: once more than one provider is connected, let the user control which
one is used first and cap how much of each is consumed.

**Prompt:**
> Read `chat_project_bible.md` — the "Priority and per-provider quotas"
> paragraph under "Storage," and the updated `storage_accounts` and
> `media_files` schema (`priority`, `quota_bytes`, `bytes_used` on
> `storage_accounts`; `storage_account_id` on `media_files`). Build:
> - Settings UI: let the user set a priority order across their linked
>   providers, and an optional quota (in GB) per provider.
> - Upload logic: when generating media, try the highest-priority linked
>   provider with room available; if it's at quota (or the upload fails),
>   fall through to the next provider in priority order, and finally to local
>   disk (still subject to the 5GB cap) if none are available.
> - Track `bytes_used` per `storage_accounts` row, updated on upload/delete,
>   same denormalized-counter pattern as `users.storage_used_bytes`.
> - Extend the "Verify cloud files" action (introduced in Step 8) to also
>   recompute each provider's `bytes_used` from the sum of its still-reachable
>   `media_files` (excluding rows flagged `unavailable_at`), so quota
>   enforcement and fallthrough stay honest after out-of-band deletions — the
>   cloud analogue of Step 7's local recompute utility.
> - Notice banner: surface an in-app notification when any linked provider
>   hits its quota, same pattern as the existing 3.5GB local-storage notice.
>
> When done, stop and tell me how to test the priority/fallthrough behavior
> without needing to actually fill a real quota. Wait for my confirmation
> before starting Step 10.

**You test:**
- [ ] Connect at least two providers, set an explicit priority order, confirm new media goes to the top-priority one
- [ ] Set a small quota on the top-priority provider (small enough to hit in testing), confirm uploads fall through to the next provider once it's reached
- [ ] Confirm the notice banner appears when a provider's quota is hit
- [ ] Confirm `bytes_used` on each `storage_accounts` row matches reality (sum of files actually sent there)
- [ ] Delete some files directly in a provider (out-of-band), run "Verify cloud files" — confirm that provider's `bytes_used` drops to the true sum of what's still there, and quota/fallthrough reflects the corrected number
- [ ] With all linked providers at quota, confirm it correctly falls back to local disk (and respects the 5GB cap there too)

**Do not proceed to Step 10 until all of the above are confirmed.**

---

## Step 10 — WebDAV Fallback (optional — build only if you decide you need it)

**Prompt:**
> Read `chat_project_bible.md` — the "Tier 2 — generic WebDAV fallback"
> section. Build a generic WebDAV adapter (endpoint URL + username/password
> or app token, manually entered, no native folder picker) using the same
> `storage_accounts` table pattern as Steps 8–9, with `provider = 'webdav'`,
> including it in the same priority/quota logic from Step 9.
>
> When done, stop and tell me how to test it. Wait for my confirmation before
> starting Step 11.

**You test:**
- [ ] Connect a real WebDAV endpoint (Nextcloud, Icedrive, or similar), confirm credentials are stored encrypted
- [ ] Generate media with WebDAV connected, confirm it lands in the right place
- [ ] Confirm it doesn't count against the local 5GB cap
- [ ] Confirm it participates correctly in priority ordering alongside the other connected providers

**Do not proceed to Step 11 until confirmed (or skip this step entirely if
you've decided you don't need it yet).**

---

## Step 11 — Settings / Account Menu Completion

**Goal**: everything in the settings menu that isn't already built —
profile editing, credits display, account deletion.

**Prompt:**
> Read `chat_project_bible.md` — the "Settings / Account Menu" section, the
> "Spend Tracking" section, and the account-deletion note (local + DB records
> only, cloud files left alone). Build:
> - Edit profile (whatever fields exist beyond email/password at this point).
> - Credits display: `GET /api/v1/auth/key` using the user's stored key,
>   shown in settings.
> - Spend dashboard: compute and store `cost_usd` on each assistant/output
>   message at generation time (model pricing x actual usage from the
>   OpenRouter response). Show total spend (all-time and this month),
>   breakdown by model, and breakdown by chat.
> - Delete account: removes the user's chats, messages, local media files
>   (disk + DB), API key, storage account links, sessions, and trusted
>   devices. Leaves any files already pushed to the user's own cloud folders
>   untouched. Require an explicit confirmation step before this executes —
>   it's irreversible.
>
> When done, stop and tell me how to test all of this, especially account
> deletion. Wait for my confirmation — this is the last step.

**You test:**
- [ ] Profile edits save and persist
- [ ] Credits display matches what's shown on openrouter.ai for that key
- [ ] Send a few messages/generations across different models and chats, confirm the spend dashboard's total roughly matches the drop in your actual OpenRouter balance
- [ ] Confirm the by-model and by-chat breakdowns add up to the same total
- [ ] Create a disposable test account, generate some local media, connect a cloud provider and generate media there too
- [ ] Delete the test account — confirm local media is gone from disk, DB rows are gone, but the cloud-folder files are still sitting untouched in the cloud provider
- [ ] Confirm the deleted account genuinely can't log in anymore afterward

**Once confirmed, the build is complete against the current bible.** Anything
you want to add from here is a new feature, not a gap in this plan — update
`chat_project_bible.md` first, then write a new step for it following this
same pattern.
