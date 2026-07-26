import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.js';
import { config } from '../config.js';
import { deleteRef } from './local.js';

// Local-storage accounting (Step 7). `users.storage_used_bytes` is a denormalized
// running counter maintained on every write path; the ground truth is the sum of
// each user's local `media_files.size_bytes`. This module owns the read side
// (status), the decrement-on-delete path, and a recompute that re-syncs the
// counter to ground truth (repairing drift from earlier increment-only builds).

// True on-disk total for a user: sum of their local media_files.size_bytes.
// Sizes are far below 2^53 (a 5 GB cap × any realistic file count), so Number
// is safe here.
export async function trueLocalBytes(db, userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(mf.size_bytes), 0)::bigint AS total
       FROM media_files mf
       JOIN messages m ON m.id = mf.message_id
       JOIN chats c    ON c.id = m.chat_id
      WHERE c.user_id = $1 AND mf.storage_location = 'local'`,
    [userId],
  );
  return Number(rows[0].total);
}

// Current usage snapshot for the storage endpoint + settings display.
export async function getStorageStatus(userId) {
  const { rows } = await pool.query(
    'SELECT storage_used_bytes FROM users WHERE id = $1',
    [userId],
  );
  const usedBytes = rows.length ? Number(rows[0].storage_used_bytes) : 0;
  return {
    usedBytes,
    capBytes: config.maxLocalBytes,
    noticeBytes: config.noticeLocalBytes,
    atNotice: usedBytes >= config.noticeLocalBytes,
    atCap: usedBytes >= config.maxLocalBytes,
  };
}

// Reset one user's counter to the true sum of their local media. Locks the user
// row so a concurrent write-path increment can't be lost between the read and
// the write. Returns { before, after } or null if the user doesn't exist.
export async function recomputeUserStorage(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT storage_used_bytes FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const before = Number(rows[0].storage_used_bytes);
    const after = await trueLocalBytes(client, userId);
    await client.query('UPDATE users SET storage_used_bytes = $1 WHERE id = $2', [after, userId]);
    await client.query('COMMIT');
    return { before, after };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Users with their id/email for the recompute script's reporting.
export async function listUsers() {
  const { rows } = await pool.query('SELECT id, email FROM users ORDER BY created_at ASC');
  return rows;
}

// Delete a chat and release its local media in one transaction: capture the
// local file refs + byte total BEFORE the FK cascade wipes the media_files rows,
// delete the chat (cascade removes messages + media_files), then decrement the
// owner's counter. Disk unlinks happen AFTER commit so a failed unlink can't
// roll back a committed delete (an orphaned file is recoverable via recompute +
// manual cleanup; a wrongly-undone delete is worse). GREATEST(0, …) guards the
// counter against underflow if prior drift left it too low.
// Returns { deleted, freedBytes } — deleted=false when the chat isn't owned/found.
export async function deleteChatAndReleaseMedia(userId, chatId) {
  const client = await pool.connect();
  let refs = [];
  let freed = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT mf.file_ref, mf.size_bytes
         FROM media_files mf
         JOIN messages m ON m.id = mf.message_id
         JOIN chats c    ON c.id = m.chat_id
        WHERE c.id = $1 AND c.user_id = $2 AND mf.storage_location = 'local'`,
      [chatId, userId],
    );
    refs = rows.map((r) => r.file_ref);
    freed = rows.reduce((n, r) => n + Number(r.size_bytes), 0);

    const { rowCount } = await client.query(
      'DELETE FROM chats WHERE id = $1 AND user_id = $2',
      [chatId, userId],
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return { deleted: false, freedBytes: 0 };
    }
    if (freed > 0) {
      await client.query(
        'UPDATE users SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2',
        [freed, userId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await Promise.all(refs.map((r) => deleteRef(r)));
  return { deleted: true, freedBytes: freed };
}

// Files present on disk under storageDir/<userId>/ that no local media_files row
// references — the on-disk sibling of the cloud "verify" reconciliation. Orphans
// come from the rare edge cases the normal delete path can't cover: a crash
// mid-write (bytes on disk, DB row never committed) or a failed post-commit
// unlink. Only files older than minAgeMs are reported, so a genuinely in-flight
// write (written but not yet committed) is never mistaken for an orphan and
// swept out from under an active generation. Pass userId to scope to one user's
// folder; omit to scan every user. Read-only — returns [{ relpath, sizeBytes }].
export async function findOrphanFiles({ minAgeMs = 5 * 60 * 1000, userId = null } = {}) {
  const root = config.storageDir;
  const { rows } = await pool.query(
    `SELECT file_ref FROM media_files WHERE storage_location = 'local'`,
  );
  const tracked = new Set(rows.map((r) => r.file_ref));

  let userDirs = [];
  try {
    userDirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return []; // storage dir doesn't exist yet
  }
  if (userId) userDirs = userDirs.filter((d) => d === userId);

  const orphans = [];
  const now = Date.now();
  for (const uid of userDirs) {
    let files = [];
    try {
      files = (await readdir(path.join(root, uid), { withFileTypes: true }))
        .filter((f) => f.isFile())
        .map((f) => f.name);
    } catch { continue; }
    for (const name of files) {
      const relpath = `${uid}/${name}`;
      if (tracked.has(relpath)) continue;
      let st;
      try { st = await stat(path.join(root, uid, name)); } catch { continue; }
      if (now - st.mtimeMs < minAgeMs) continue; // too new — possible in-flight write
      orphans.push({ relpath, sizeBytes: st.size });
    }
  }
  return orphans;
}

// Unlink the given orphans (uses the traversal-guarded deleteRef). Returns the
// bytes freed. Orphans are untracked, so this never touches the counter.
export async function deleteOrphanFiles(orphans) {
  let freed = 0;
  for (const o of orphans) {
    await deleteRef(o.relpath);
    freed += o.sizeBytes;
  }
  return freed;
}
