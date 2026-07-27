import { pool } from '../db.js';
import { disconnectAccount } from '../storage/accounts.js';
import { deleteUserStorageDir } from '../storage/local.js';

// Account-level operations for the Settings menu (Step 11): the spend dashboard
// (aggregation over messages.cost_usd, which is already computed + stored at
// generation time across text/image/video) and irreversible account deletion.

// Spend dashboard data: total (all-time + this calendar month) and the same
// numbers grouped by model and by chat. cost_usd is numeric(12,6); cast to
// float8 so it arrives as a JS number rather than a string. Only assistant/
// output rows carry a cost, so the IS NOT NULL filter scopes to those.
export async function getSpend(userId) {
  const totals = await pool.query(
    `SELECT
        COALESCE(SUM(m.cost_usd), 0)::float8 AS all_time,
        COALESCE(SUM(m.cost_usd) FILTER (WHERE m.created_at >= date_trunc('month', now())), 0)::float8 AS this_month,
        COUNT(*)::int AS count
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
      WHERE c.user_id = $1 AND m.cost_usd IS NOT NULL`,
    [userId],
  );

  // Model id lives in the assistant row's metadata (set on every generated turn);
  // fall back to the chat's model_id, then a label so nothing gets dropped.
  const byModel = await pool.query(
    `SELECT COALESCE(m.metadata ->> 'model', c.model_id, '(unknown model)') AS model,
            SUM(m.cost_usd)::float8 AS total,
            COUNT(*)::int           AS count
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
      WHERE c.user_id = $1 AND m.cost_usd IS NOT NULL
      GROUP BY 1
      ORDER BY total DESC`,
    [userId],
  );

  const byChat = await pool.query(
    `SELECT c.id, c.title, c.modality,
            SUM(m.cost_usd)::float8 AS total,
            COUNT(*)::int           AS count
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
      WHERE c.user_id = $1 AND m.cost_usd IS NOT NULL
      GROUP BY c.id, c.title, c.modality
      ORDER BY total DESC`,
    [userId],
  );

  return {
    allTime: totals.rows[0].all_time,
    thisMonth: totals.rows[0].this_month,
    count: totals.rows[0].count,
    byModel: byModel.rows.map((r) => ({ model: r.model, total: r.total, count: r.count })),
    byChat: byChat.rows.map((r) => ({
      id: r.id,
      title: r.title || 'Untitled chat',
      modality: r.modality,
      total: r.total,
      count: r.count,
    })),
  };
}

// Irreversible account deletion (bible: local + DB records only; files already
// pushed to the user's own cloud folders are left untouched). Order matters:
//  1. Best-effort revoke connected cloud providers at the provider AND drop the
//     row — needs the still-present encrypted refresh token, so it runs first.
//     The user's actual Drive files are NOT deleted (their data, their account).
//  2. DELETE the users row — the FK cascade removes chats, messages, media_files,
//     api_keys, totp_secrets, trusted_devices, and storage_accounts.
//  3. Sessions aren't FK-linked to users (connect-pg-simple owns that table), so
//     purge the user's sessions explicitly by the userId stashed in `sess`.
//  4. Remove the user's local media directory from disk (after the rows are gone).
export async function deleteAccount(userId) {
  // Step 1 — revoke cloud tokens while they still exist. Only Google Drive is
  // supported today; best-effort, never blocks deletion.
  try {
    await disconnectAccount(userId, 'google_drive');
  } catch {
    /* best effort — a failed revoke must not block account deletion */
  }

  // Step 2 — cascade-delete all of the user's DB records.
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);

  // Step 3 — purge session rows for this user (no FK to cascade through).
  await pool.query(`DELETE FROM sessions WHERE (sess ->> 'userId') = $1`, [String(userId)]);

  // Step 4 — remove local media from disk. DB is already authoritative-empty, so
  // a failure here only leaves harmless orphan bytes (cleanable via the sweep).
  await deleteUserStorageDir(userId);
}
