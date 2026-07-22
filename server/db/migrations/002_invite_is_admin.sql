-- ─────────────────────────────────────────────────────────────────────────
-- 002_invite_is_admin
-- Invite tokens need to carry whether the account they create is an admin,
-- so the *first* admin can be bootstrapped through the normal invite flow
-- (there's no existing admin to grant it otherwise). Additive column only.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE invite_tokens
  ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
