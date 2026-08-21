# AGENTS.md

System context for AI edits to **mmchat** — a BYOK multi-model AI chat client
(text/image/video via OpenRouter). Source of truth for scope/schema/security is
`chat_project_bible.md`; staged build plan is `build_guide.md`.

## 1. Tech Stack & Environment

- **Runtime:** Node.js ≥20, **ESM only** (`"type":"module"` in both workspaces).
- **Monorepo:** npm workspaces — `client/` + `server/`. `concurrently` for dev.
- **Frontend:** React 18, Vite 6, `react-router-dom`, hand-written CSS (`src/styles.css`), React Context for state. No UI framework.
- **Backend:** Express; `express-session` + `connect-pg-simple` (Postgres sessions); `helmet`, `cookie-parser`, `express-rate-limit`, `multer`.
- **DB:** PostgreSQL 16. Raw-SQL migrations via a custom runner (`server/db/migrate.js`), tracked in `schema_migrations`. `gen_random_uuid()` (core).
- **Auth/crypto:** `@node-rs/argon2` (passwords), `otplib` + `qrcode` (TOTP), Node `crypto` AES-256-GCM (secrets at rest), SHA-256 (token hashing).
- **External APIs:** OpenRouter (BYOK — user's own key, no server key); Google Drive REST over `fetch` (no SDK).

## 2. Terminal Commands

```sh
# Install (root — installs both workspaces)
npm install

# Dev servers: API :8000 + Vite :5173 (both, via concurrently)
npm run dev                 # plain local
npm run dev:proxy           # behind nginx (sets VITE_BEHIND_PROXY=1)

# DB migrations
npm run migrate             # apply pending
npm run migrate:status      # show applied/pending

# Client production build
npm run build:client

# Whole-repo bundle (mmchat-bundle.md) — see "Repo bundle" below
npm run setup:hooks         # once per clone: point git at .githooks/
npm run bundle              # regenerate manually (the pre-commit hook does this too)

# One-off CLIs (from server/)
node scripts/create-invite.js --admin        # mint first/admin invite token
node scripts/reset-user.js --email X ...      # manual pw/TOTP/admin recovery
node scripts/recompute-storage.js --dry-run   # reconcile storage counters
```

**Repo bundle:** `mmchat-bundle.md` is a generated single-file concatenation of
every tracked file (built from `git ls-files` by `scripts/gen-bundle.mjs`), kept
for pasting the whole repo into a model context. **Don't hand-edit it** — it is
regenerated and re-staged automatically by `.githooks/pre-commit`, so a manual
edit is overwritten on the next commit. The generator also scans tracked files
for credentials and exits non-zero on a hit, which aborts the commit — so a
secret can never be baked into the shared bundle. A fresh clone must run
`npm run setup:hooks` once (sets `core.hooksPath`) or the hook won't fire.

**Tests:** there is **no automated test suite** (manual-test driven per
`build_guide.md`). Verify changes with: `node --check <file>` (server syntax),
`npm run build:client` (client compiles), and manual testing. Historically,
ad-hoc checks used a throwaway Dockerized Postgres 16 + a mock OpenRouter.

## 3. Invariants & Coding Rules

- **ESM only** — `import`/`export`, no `require()` in `src`.
- **Per-user isolation is absolute.** Every query scopes to `req.session.userId`
  (owner-check via joins). Never trust a client-supplied user/owner id.
- **BYOK:** no server-wide OpenRouter key. Decrypt the user's key at request time
  only, never log it, return only the last-4 suffix to the client.
- **Secrets/PII never in the repo.** No domain/host/IP/real keys in committed
  files. Config via env: `.env` gitignored, `.env.example` committed with
  placeholders. Client-exposed vars **must** be `VITE_`-prefixed (e.g.
  `VITE_CONTACT_EMAIL`). Grep committed files before committing.
- **Encrypt-at-rest** anything sensitive (OpenRouter key, Drive refresh token) via
  `crypto/encryption.js` (AES-256-GCM); hash tokens via `crypto/tokens.js`.
- **Sessions** are server-side (Postgres), httpOnly cookies — **no JWT, no
  localStorage tokens**. The `sessions` table has no FK to `users`; when purging a
  user, delete rows matched by `sess ->> 'userId'`.
- **`cost_usd`** is set on assistant/output rows only; prefer OpenRouter's returned
  `usage.cost`, fall back to a computed estimate only when cleanly per-unit.
- **Message ordering:** insert the user + assistant turn in one txn using
  `clock_timestamp()` for `created_at` (never the shared `now()` — ties transpose),
  and list with `ORDER BY created_at ASC, (role <> 'user') ASC`.
- **Storage counter** (`users.storage_used_bytes`) is denormalized; maintain it
  symmetrically — increment on local write, decrement on delete with
  `GREATEST(0, …)`. Only `storage_location='local'` counts; **cloud writes skip the
  counter/cap**. Unlink disk files **after** commit.
- **Spend protection — do not remove:** the pending-per-chat partial unique index
  (migration `003`), the per-user advisory lock on video submit, or idempotency-key
  handling. One pending generation per chat.
- **Migrations are additive + immutable.** Never edit an applied migration; add the
  next `NNN_name.sql`. Sequential numbering.
- **Error handling:** classify OpenRouter/HTTP errors via `classifyError` →
  `category` of `key|credits|model|request`; surface the real provider message and
  distinguish "fix your key/credits" from "try another model". Return
  `{ error, category }` JSON (pre-flight) or an SSE `{type:'error'}` mid-stream.
- **Streaming is SSE, not WebSocket.** Video is **async + polled** (submit →
  `202 {id, polling_url}` → poll `GET /videos/{id}`) with on-load reconciliation;
  **no webhook** (`callback_url` unused).
- **Image input works in all three modalities**, gated per-model via
  `GET /api/models/capabilities?id=&modality=` (routes to the right catalogue —
  the chat `/models` list never holds image/video-gen models). Uploaded images
  are persisted as `input` media (local, counted) **and** sent to OpenRouter as
  base64 data URIs: text → `image_url` content part; image-gen → `input_references`;
  video-gen → `frame_images` with `frame_type:'first_frame'` (one frame, capped
  client-side). Capability sources differ: `input_modalities` on `/models` (text)
  and `/images/models` (image); **`supported_frame_images`** on `/videos/models`
  (video — that catalogue has no `architecture`). Only **images** upload, never
  video files. Reverse-proxy body limit must exceed the 20 MB multer cap (nginx's
  1 MB default silently `413`s uploads).
- **Cloud out-of-band deletes:** soft-flag `media_files.unavailable_at`; **never
  hard-delete a media row** (message history + `cost_usd` must survive).
- **Deleting a chat/account leaves the user's Google Drive files intact** (by
  design); only local disk files are unlinked.
- **No email service exists** anywhere (recovery is manual/CLI). Don't add one.
- **Don't edit `chat_project_bible.md` / `build_guide.md` or `git commit` unless
  explicitly asked.**

## 4. Directory Map

| Path | Responsibility |
|---|---|
| `server/src/index.js` | Express app: middleware, session store, route mounting |
| `server/src/config.js` | Env parsing/validation (single source of config) |
| `server/src/auth/` | Invite signup, login, TOTP, trusted-device cookies, sessions |
| `server/src/crypto/` | AES-256-GCM encryption + SHA-256 token hashing |
| `server/src/keys/` | BYOK OpenRouter key: encrypted storage, credits |
| `server/src/openrouter/` | OpenRouter API client (models/chat/images/videos/auth) + catalogue routes |
| `server/src/chats/` | Chat CRUD + generation: `completion` (text SSE), `imagegen`, `videogen` |
| `server/src/media/` | Serve stored media (local + cloud passthrough) |
| `server/src/storage/` | Local accounting, disk I/O, cloud accounts, `providers/googleDrive` |
| `server/src/account/` | Settings menu: profile edit, spend dashboard, account deletion |
| `server/db/migrations/` | Sequential raw-SQL schema migrations |
| `server/scripts/` | Operational CLIs (invite, reset-user, recompute-storage) |
| `scripts/gen-bundle.mjs` | Regenerates `mmchat-bundle.md` + scans tracked files for secrets |
| `.githooks/pre-commit` | Runs the bundle generator and stages the result (enable: `npm run setup:hooks`) |
| `client/src/pages/` | Route views (Login, Register, Chat, Settings) |
| `client/src/chat/` | Chat shell, sidebar, model picker, contexts, SSE reader |
| `client/src/auth/` | `AuthContext` + TOTP enrollment UI |
| `client/src/api.js` | `fetch` wrapper for same-origin `/api` (cookies included) |


---

## Git workflow & safety (applies to every agent and every human)

These rules are identical across all of this owner's active repos. The full
reference lives outside this repo, in `~/GIT-WORKFLOW.md` on the dev box.

### The invariant

**GitHub `main` is the single source of truth.** Every writer reads from and
writes to GitHub. Never assume a local checkout is current — always pull first;
another agent may have moved `main` since you last looked.

### Branch and PR flow

- **Never commit directly to `main`.** Every change goes on a branch and lands
  through a pull request, no matter how small or who is making it.
- Branch naming: `feat/…`, `fix/…`, `docs/…`, `chore/…` plus a short slug
  (`feat/red-ink-reservoir`, not `feature-red-ink-17588214011985568848`).
- **One logical change per commit.** Do not bundle unrelated work — a commit
  touching scoring, timing, and enemy behaviour at once cannot be reviewed or
  reverted. Split it.
- Commit subject: imperative mood, ≤72 characters, no trailing period
  ("Add red ink reservoir", not "Added red ink reservoir.").
- PRs squash-merge, so the PR title becomes the commit on `main` — write it as
  the commit message you want to keep.

### Never commit secrets or PII

This is a hard rule with no exceptions.

- **No credentials**: API keys, tokens, passwords, private keys, connection
  strings. They belong in `.env` (gitignored) or in deploy-only config.
- **No personal information**: real email addresses, phone numbers, street
  addresses, or any end-user data. Role addresses on the project's own domain
  (`support@…`, `noreply@…`) are fine; personal mailboxes are not.
- A `gitleaks` check runs on every PR and will fail the build. On the dev box a
  pre-commit hook blocks it earlier. If you hit a false positive, add a trailing
  `gitleaks:allow` comment on the line or a fingerprint to `.gitleaksignore` —
  never disable the check itself.

### Never touch runtime state or deploy config

- Anything gitignored is runtime state that lives only on the server —
  databases, `data/`, `.env`, uploads, salts. Do not add, move, or "clean up"
  these paths.
- Do not edit PM2 configs, nginx configs, systemd units, or port numbers. The
  deploy environment is managed outside this repo.
- Do not change the port an app listens on, or add a build step to a project
  that deliberately has none.

### Before you finish

- Ensure the app still starts and the primary flow works (see the testing
  section above for this project's specifics).
- Leave the working tree clean — no stray scratch files, no commented-out
  debris, no `console.log` left from debugging.
