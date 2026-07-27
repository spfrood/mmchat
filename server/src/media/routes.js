import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { resolveRef, contentTypeFor } from '../storage/local.js';
import { getAccountById, getAccessToken } from '../storage/accounts.js';
import * as drive from '../storage/providers/googleDrive.js';

// /api/media/:id — serve a stored media file (local disk or a linked cloud
// folder), but only to the user who owns the chat it belongs to. Ownership is
// enforced by joining through messages -> chats -> user_id.
export const mediaRouter = Router();

mediaRouter.use(requireAuth);

// Mark a cloud file that vanished on the provider side as unavailable (lazy
// out-of-band detection). Idempotent; kept, not deleted, so history survives.
async function flagUnavailable(mediaId) {
  await pool
    .query('UPDATE media_files SET unavailable_at = now() WHERE id = $1 AND unavailable_at IS NULL', [mediaId])
    .catch(() => {});
}

mediaRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT mf.id, mf.file_ref, mf.storage_location, mf.storage_account_id,
              mf.content_type, mf.unavailable_at
         FROM media_files mf
         JOIN messages m ON m.id = mf.message_id
         JOIN chats c ON c.id = m.chat_id
        WHERE mf.id = $1 AND c.user_id = $2`,
      [req.params.id, req.session.userId],
    );
    const media = rows[0];
    if (!media) return res.status(404).json({ error: 'Not found' });

    // Already known-gone (out-of-band delete): don't re-fetch.
    if (media.unavailable_at) {
      return res.status(410).json({ error: 'This file is no longer available in your cloud storage.', category: 'unavailable' });
    }

    if (media.storage_location === 'local') {
      res.setHeader('Content-Type', media.content_type || contentTypeFor(media.file_ref));
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      return res.sendFile(resolveRef(media.file_ref), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
      });
    }

    if (media.storage_location === 'google_drive') {
      // No account link (e.g. the provider was disconnected) → can't fetch it.
      const account = media.storage_account_id ? await getAccountById(media.storage_account_id) : null;
      if (!account) {
        return res.status(410).json({ error: 'This file is stored in a cloud account that is no longer connected.', category: 'unavailable' });
      }
      let dr;
      try {
        const token = await getAccessToken(account);
        dr = await drive.downloadFile(token, media.file_ref);
      } catch (err) {
        console.error('[media] drive fetch failed:', err.message);
        return res.status(502).json({ error: 'Could not reach your cloud storage.', category: 'model' });
      }
      if (dr.status === 404) {
        await flagUnavailable(media.id); // deleted on the provider side
        return res.status(410).json({ error: 'This file is no longer available in your cloud storage.', category: 'unavailable' });
      }
      if (!dr.ok || !dr.body) {
        return res.status(502).json({ error: 'Could not read the file from your cloud storage.', category: 'model' });
      }
      res.setHeader('Content-Type', media.content_type || dr.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      // Stream the provider response body straight through.
      const reader = dr.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        return res.end();
      } catch (err) {
        if (!res.headersSent) res.status(502).json({ error: 'Cloud download interrupted.' });
        else res.end();
      }
      return;
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Not found' });
    console.error('[media] serve failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to load media' });
  }
});
