import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { resolveRef, contentTypeFor } from '../storage/local.js';

// /api/media/:id — serve a locally-stored media file, but only to the user who
// owns the chat it belongs to. Ownership is enforced by joining through
// messages -> chats -> user_id.
export const mediaRouter = Router();

mediaRouter.use(requireAuth);

mediaRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT mf.file_ref, mf.storage_location
         FROM media_files mf
         JOIN messages m ON m.id = mf.message_id
         JOIN chats c ON c.id = m.chat_id
        WHERE mf.id = $1 AND c.user_id = $2`,
      [req.params.id, req.session.userId],
    );
    const media = rows[0];
    if (!media || media.storage_location !== 'local') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.setHeader('Content-Type', contentTypeFor(media.file_ref));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(resolveRef(media.file_ref), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
    });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Not found' });
    console.error('[media] serve failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to load media' });
  }
});
