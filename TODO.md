# TODO

Open work items for this project. Two kinds live here:

- **Deferred** — designed, intentionally not built. The design lives in
  `chat_project_bible.md` → "## Future updates"; the original build prompts are
  retained in `build_guide.md` (Steps 9–10). Don't redesign these, just pick
  them up.
- **Unbuilt** — specified in the bible but never implemented and never recorded
  as deferred. These are gaps, not decisions.

Per `build_guide.md`, anything genuinely new is a **feature**, not a gap in the
plan: update `chat_project_bible.md` first, then write a build step for it in
the same staged format. New features below are marked accordingly.

---

## Unbuilt (spec'd, not deferred)

### Pre-flight balance check for image generation
`chat_project_bible.md` → "Spend Protection" specifies a pre-flight credit check
via `GET /api/v1/auth/key` for **image *and* video** before firing an expensive
request. Only video has it — `client/src/chat/VideoConfirm.jsx` reads
`/keys/credits` and warns when an example clip would use ≥20% of the remaining
balance. `server/src/chats/imagegen.js` has no credit check at all, and there's
no image-side client equivalent.

The deviations section silently narrows this to "surfaced in the video
confirmation dialog" without noting the image half was dropped.

- [ ] Decide whether image generation gets its own confirmation step or an
      inline warning (image is cheaper than video — a full modal may be too much)
- [ ] Reuse `GET /api/keys/credits`; informational warning, not a hard block,
      matching the video pattern
- [ ] Update the bible's deviations section either way

### Per-user request caps as a backstop
The bible specifies per-user request caps, "generous for text, tighter for
image, tightest for video." Not built. The only `express-rate-limit` instances
are `loginLimiter` / `registerLimiter` in `server/src/auth/middleware.js`,
applied solely to auth routes. No generation route
(`POST /api/chats/:id/messages`, `/images`, `/videos`) carries a limiter.

What exists covers only part of the intent:

- one-pending-generation-per-chat (partial unique index, migration `003`)
- `MAX_CONCURRENT_VIDEOS` per user (advisory-lock guarded)

Both are **concurrency** guards, not **rate** caps — nothing stops a long run of
sequential requests. Text has no backstop of any kind.

- [ ] Add per-user, per-modality request caps over a rolling window
- [ ] Counter must live in Postgres (or Redis), **not** in-process memory — the
      bible flags this explicitly for PM2 cluster mode
- [ ] Tune: generous for text, tighter for image, tightest for video

### Model picker "specialty" filter
Spec'd as optional and best-effort in the bible's "Model picker" (keyword-match
the model `description` for coding / vision / reasoning, since it isn't a
structured field on `/models`). Recorded as **not built** in both
`chat_project_bible.md` and `build_guide.md` — a documented skip rather than an
oversight, but it never landed in "## Future updates", so it isn't tracked
anywhere else.

- [ ] Build it, or formally move it to "Future updates" and drop it from here

---

## Deferred (designed, not built)

Full design in `chat_project_bible.md` → "## Future updates". Google Drive is
the sole provider for now, which is what makes all of this deferrable.

### Additional cloud storage providers
- [ ] **Dropbox** (DBX Platform) — native OAuth, same pattern as Google Drive
- [ ] **OneDrive** (Microsoft Graph API) — native OAuth, same pattern
- [ ] **Generic WebDAV fallback** (`build_guide.md` Step 10) — endpoint URL +
      username/password or app token, entered manually, no native folder picker.
      Covers Icedrive, Internxt, self-hosted Nextcloud and similar.

`storage_accounts.provider` and `media_files.storage_location` already allow
`dropbox|onedrive|webdav`, so each provider is a new module + routes, **not** a
migration.

**Explicitly excluded** — don't build without re-confirming current provider
docs: iCloud (no public third-party write API), Mega / NordLocker / Internxt as
native integrations (client-side encryption is incompatible with server-side
writes; Internxt only via WebDAV), IDrive (no confirmed general-purpose write
API for the consumer product).

### Multi-provider priority + per-provider quotas
`build_guide.md` Step 9. Only meaningful once more than one provider can be
linked, so it blocks on the above.

- [ ] Settings UI: explicit priority order across linked providers
- [ ] Optional per-provider quota (GB) capping what this app may consume there
- [ ] Upload fallthrough: highest-priority provider with room → next provider →
      local disk (still under the 5 GB cap)
- [ ] Per-account `bytes_used` tracking on `storage_accounts` (columns already
      exist), maintained on upload/delete
- [ ] Extend "Verify cloud files" to recompute each provider's `bytes_used` from
      still-reachable `media_files` (excluding rows flagged `unavailable_at`), so
      quotas stay honest after out-of-band deletion
- [ ] Quota notice banner, same pattern as the local 3.5 GB notice, so
      fallthrough is never silent

---

## New features

### User-selectable cached prompt context
**Status:** proposed — not in the bible yet. Needs a bible entry + build step
before implementation.

**Problem.** Context is currently an unbounded full replay. On every send,
`server/src/chats/completion.js` loads *every* prior row for the chat —

```sql
SELECT role, content FROM messages
 WHERE chat_id = $1 AND content IS NOT NULL AND role IN ('system','user','assistant')
 ORDER BY created_at ASC
```

— with no `LIMIT`, no token budget, and no truncation, then appends the new
turn. Both sides of the conversation are replayed, so per-message prompt cost
grows roughly quadratically over a chat's life, and a long thread eventually
just fails against the model's context limit. The user has no control over any
of it.

**Goal.** Let the user choose which earlier turns are sent as context with a new
prompt, instead of always sending the whole thread.

- [ ] **Selection UI** — a per-message include/exclude control in the thread
      (checkbox or pin affordance), plus bulk actions: select none, select all,
      last N turns. Selection state must be visible at a glance while composing,
      since it directly determines what the model sees and what the turn costs.
- [ ] **Pairing rule** — decide whether selecting a user turn implicitly pulls in
      its assistant reply. Recommend **yes by default, with an override**:
      sending a question without its answer is usually a mistake, but "just the
      prompts" is exactly what someone re-running a series of instructions
      wants. This is the main design decision to settle before building.
- [ ] **Persistence** — store the selection per chat (a `context_selected`
      boolean on `messages`, or a selection set on `chats`) so it survives
      reload, matching how the rest of the app persists chat state.
- [ ] **Server enforcement** — the history query must filter on the selection.
      Never trust a client-supplied message list: the client sends *intent*, the
      server rebuilds the payload from its own rows, consistent with how the
      current turn is assembled today.
- [ ] **Always-included turns** — a way to mark a turn as permanently pinned
      (standing instructions that should ride along with every send regardless of
      the rest of the selection). This is the natural place to finally use the
      `'system'` role: the history filter already admits `role = 'system'` but
      nothing in the codebase writes such a row today.
- [ ] **Cost feedback** — show an estimated context size for the current
      selection before sending. This is the feature's main payoff and should be
      visible while selecting, not after the spend.
- [ ] **Prompt caching interaction** — the "cached" half of this. Providers that
      cache prompt prefixes only hit the cache when the *prefix is byte-identical*
      to the previous request, so removing a turn from the middle of a thread
      invalidates everything after it. Selections that only ever trim from the
      **tail**, or that keep a stable pinned prefix, stay cache-friendly;
      arbitrary middle-of-thread deselection does not. Verify OpenRouter's
      current caching behaviour and per-model support before promising any saving
      here — treat the cost benefit as unproven until measured.

**Known interaction:** past images already drop out of context automatically,
since the history query selects only `content` and never re-sends attachments.
Whether selecting an old turn should also re-attach its image is an open
question, and it is not free — images are re-encoded as base64 data URIs and are
substantially more expensive than text.
