import { pool } from '../db.js';
import { writeUserFile, deleteRef } from './local.js';
import { getActiveCloudAccount, getAccessToken } from './accounts.js';
import * as drive from './providers/googleDrive.js';

// Where a user's *generated* output goes: their active cloud account if one is
// linked with a folder, else local disk. (Uploaded vision *input* stays local
// this pass — the Step 8 prompt scopes cloud offload to generation output.)
export async function resolveOutputTarget(userId) {
  const account = await getActiveCloudAccount(userId);
  return account ? { kind: account.provider, account } : { kind: 'local' };
}

function extFromMime(mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('webm')) return '.webm';
  if (m.includes('quicktime')) return '.mov';
  if (m.includes('matroska')) return '.mkv';
  return '';
}

// Write generated output to the resolved target and record it: insert one
// media_files row per file, mark the assistant message complete + set cost, and
// bump the storage counter by the LOCAL bytes only (cloud files don't count
// against the 5 GB cap). Cloud uploads happen before the DB transaction; if
// anything fails, everything written so far (local files or cloud uploads) is
// cleaned up and the error rethrown, so the caller's failure path is unchanged.
// `buffers`: [{ buffer, mimetype }]. Returns { location } for logging.
export async function persistGeneratedOutput({ userId, messageId, chatId, buffers, cost }) {
  const target = await resolveOutputTarget(userId);
  const written = []; // { location, fileRef, sizeBytes, accountId, contentType }
  let accessToken = null;

  try {
    if (target.kind === 'google_drive') accessToken = await getAccessToken(target.account);
    for (const { buffer, mimetype } of buffers) {
      if (target.kind === 'google_drive') {
        const name = `mmchat-${Date.now()}-${written.length}${extFromMime(mimetype)}`;
        const up = await drive.uploadFile(accessToken, {
          buffer, mimetype, name, folderId: target.account.folder_ref,
        });
        written.push({ location: 'google_drive', fileRef: up.fileId, sizeBytes: up.size, accountId: target.account.id, contentType: mimetype });
      } else {
        const w = await writeUserFile(userId, { buffer, mimetype, originalname: 'generated' });
        written.push({ location: 'local', fileRef: w.fileRef, sizeBytes: w.sizeBytes, accountId: null, contentType: mimetype });
      }
    }
  } catch (err) {
    await cleanup(written, accessToken);
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const w of written) {
      await client.query(
        `INSERT INTO media_files (message_id, direction, storage_location, storage_account_id, file_ref, size_bytes, content_type)
         VALUES ($1, 'output', $2, $3, $4, $5, $6)`,
        [messageId, w.location, w.accountId, w.fileRef, w.sizeBytes, w.contentType],
      );
    }
    await client.query(
      `UPDATE messages SET metadata = jsonb_set(metadata, '{status}', '"complete"'), cost_usd = $2 WHERE id = $1`,
      [messageId, cost],
    );
    const localBytes = written.filter((w) => w.location === 'local').reduce((n, w) => n + w.sizeBytes, 0);
    if (localBytes > 0) {
      await client.query('UPDATE users SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2', [localBytes, userId]);
    }
    await client.query('UPDATE chats SET updated_at = now() WHERE id = $1', [chatId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await cleanup(written, accessToken);
    throw err;
  }
  client.release();
  return { location: target.kind };
}

async function cleanup(written, accessToken) {
  await Promise.all(written.map(async (w) => {
    if (w.location === 'local') return deleteRef(w.fileRef);
    if (w.location === 'google_drive' && accessToken) return drive.deleteFile(accessToken, w.fileRef);
  }));
}
