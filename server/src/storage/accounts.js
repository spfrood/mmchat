import { pool } from '../db.js';
import { encrypt, decrypt } from '../crypto/encryption.js';
import * as drive from './providers/googleDrive.js';

// storage_accounts service: linked cloud providers (Step 8 = Google Drive only).
// Refresh tokens live encrypted at rest (same AES-256-GCM master key as the
// OpenRouter key); short-lived access tokens are derived on demand and cached in
// process. Under PM2 cluster each worker keeps its own cache — harmless, it's
// just an optimization over refreshing on every request.

const tokenCache = new Map(); // storage_account.id -> { accessToken, expiresAt }

const COLS = 'id, user_id, provider, encrypted_refresh_token, folder_ref, priority, connected_at';

export async function getAccount(userId, provider) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM storage_accounts WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
  return rows[0] || null;
}

export async function getAccountById(id) {
  const { rows } = await pool.query(`SELECT ${COLS} FROM storage_accounts WHERE id = $1`, [id]);
  return rows[0] || null;
}

// The account new generation output should upload to: the highest-priority
// linked account that has a target folder. Step 8 has at most one (Drive);
// Step 9 generalizes the priority/quota fallthrough.
export async function getActiveCloudAccount(userId) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM storage_accounts
      WHERE user_id = $1 AND folder_ref IS NOT NULL
      ORDER BY priority ASC, connected_at ASC
      LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

export async function listAccounts(userId) {
  const { rows } = await pool.query(
    `SELECT id, provider, folder_ref, priority, connected_at
       FROM storage_accounts WHERE user_id = $1 ORDER BY priority ASC, connected_at ASC`,
    [userId],
  );
  return rows;
}

// A valid access token for an account (cached until ~30s before expiry, else
// refreshed from the stored refresh token). google_drive only for now.
export async function getAccessToken(account) {
  const cached = tokenCache.get(account.id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
  const refreshToken = decrypt(account.encrypted_refresh_token);
  const { accessToken, expiresIn } = await drive.refreshAccessToken(refreshToken);
  tokenCache.set(account.id, { accessToken, expiresAt: Date.now() + (expiresIn || 3600) * 1000 });
  return accessToken;
}

// Insert or update the user's account for a provider (reconnect is idempotent
// via the (user_id, provider) unique constraint). → account id.
export async function saveAccount({ userId, provider, refreshToken, folderRef }) {
  const enc = encrypt(refreshToken);
  const { rows } = await pool.query(
    `INSERT INTO storage_accounts (user_id, provider, encrypted_refresh_token, folder_ref)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, provider) DO UPDATE
       SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
           folder_ref   = EXCLUDED.folder_ref,
           connected_at = now()
     RETURNING id`,
    [userId, provider, enc, folderRef],
  );
  const accountId = rows[0].id;
  tokenCache.delete(accountId); // force a fresh token against the new refresh token

  // Re-adopt this user's cloud media that a previous disconnect orphaned (the FK
  // set storage_account_id NULL when the old account row was deleted). Same
  // provider only, and only rows not already flagged unavailable. If the user
  // reconnected a *different* account, files it can't reach simply flag
  // unavailable on the next serve — so this is safe either way, and restores
  // access in the common case of reconnecting the same account.
  await pool.query(
    `UPDATE media_files mf SET storage_account_id = $1
       FROM messages m, chats c
      WHERE mf.message_id = m.id AND m.chat_id = c.id
        AND c.user_id = $2 AND mf.storage_location = $3
        AND mf.storage_account_id IS NULL AND mf.unavailable_at IS NULL`,
    [accountId, userId, provider],
  );
  return accountId;
}

// Disconnect: revoke at the provider (best-effort) and drop the row. The FK on
// media_files is ON DELETE SET NULL, so past cloud references survive but lose
// their account link and degrade to "not available" when served. Files already
// in the user's Drive are left untouched (their data, their account).
export async function disconnectAccount(userId, provider) {
  const account = await getAccount(userId, provider);
  if (!account) return false;
  try {
    await drive.revoke(decrypt(account.encrypted_refresh_token));
  } catch { /* best effort */ }
  tokenCache.delete(account.id);
  await pool.query('DELETE FROM storage_accounts WHERE id = $1', [account.id]);
  return true;
}
