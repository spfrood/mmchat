-- ─────────────────────────────────────────────────────────────────────────
-- 003_pending_generation_guard
-- Spend-protection idempotency (bible → "Spend Protection"): the backend must
-- refuse a second generation request against a chat that already has one in
-- flight. A partial UNIQUE index enforces "at most one pending assistant/output
-- message per chat" atomically at the DB level, so two concurrent submits
-- (double-click, reload re-fire) can't both spend — the second INSERT fails.
--
-- metadata.status is set to 'pending' while a generation is in flight and
-- updated to 'complete' on success (or the pending row is removed on failure).
-- ─────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX idx_messages_one_pending_per_chat
  ON messages (chat_id)
  WHERE role = 'assistant' AND (metadata ->> 'status') = 'pending';
