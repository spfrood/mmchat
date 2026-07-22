import { pool } from '../db.js';
import { randomToken, sha256 } from '../crypto/tokens.js';

// Admin-issued, single-use invite tokens. The raw token is shown once to the
// admin (out-of-band delivery); only its hash is stored. Consuming an invite
// is the only way to create an account (no self-service signup).

// Create an invite. createdByUserId is null for the bootstrap CLI (no admin
// exists yet). Returns the raw token — the only time it's visible.
export async function createInvite({ createdByUserId = null, isAdmin = false, expiresInHours = 72 }) {
  const raw = randomToken(24);
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `INSERT INTO invite_tokens (token_hash, created_by_user_id, is_admin, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, expires_at, is_admin`,
    [tokenHash, createdByUserId, isAdmin, expiresAt],
  );
  return { raw, ...rows[0] };
}

// Look up a usable invite by its raw token (unused + unexpired). Read-only.
export async function findUsableInvite(rawToken) {
  if (!rawToken) return null;
  const { rows } = await pool.query(
    `SELECT id, is_admin, expires_at, used_at
       FROM invite_tokens
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [sha256(rawToken)],
  );
  return rows[0] || null;
}
