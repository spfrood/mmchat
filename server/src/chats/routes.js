import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { listMessages, sendMessage } from './completion.js';

// Attachments are held in memory (small images) so we can both base64-embed them
// in the OpenRouter request and write them to local storage. multer only parses
// multipart requests; plain-JSON sends pass straight through.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: config.maxAttachments },
});

function uploadAttachments(req, res, next) {
  upload.array('files', config.maxAttachments)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'An attachment is too large (max 20 MB each).'
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Too many attachments.'
          : 'Upload failed.';
      return res.status(400).json({ error: msg, category: 'request' });
    }
    next();
  });
}

// /api/chats — chat CRUD. A chat is a container (title, model_id, modality) with
// its own message thread; Step 2 creates/renames/deletes chats but wires up no
// real model calls, so a chat can exist with zero messages. Every query is
// scoped to req.session.userId — a user can only see/touch their own chats.
export const chatsRouter = Router();

chatsRouter.use(requireAuth);

const MODALITIES = ['text', 'image', 'video'];
const TITLE_MAX = 200;
const MODEL_ID_MAX = 200;

function publicChat(row) {
  return {
    id: row.id,
    title: row.title,
    modelId: row.model_id,
    modality: row.modality,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanTitle(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim().slice(0, TITLE_MAX);
  return t.length ? t : null;
}

function cleanModelId(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim().slice(0, MODEL_ID_MAX);
  return t.length ? t : null;
}

// List the user's chats, most-recently-updated first.
chatsRouter.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, model_id, modality, created_at, updated_at
         FROM chats WHERE user_id = $1
        ORDER BY updated_at DESC`,
      [req.session.userId],
    );
    res.json({ chats: rows.map(publicChat) });
  } catch (err) {
    console.error('[chats] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load chats' });
  }
});

// Create a chat. modality defaults to 'text'; title/model_id optional.
chatsRouter.post('/', async (req, res) => {
  const { title, modelId, modality = 'text' } = req.body || {};
  if (!MODALITIES.includes(modality)) {
    return res.status(400).json({ error: `modality must be one of: ${MODALITIES.join(', ')}` });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO chats (user_id, title, model_id, modality)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, model_id, modality, created_at, updated_at`,
      [req.session.userId, cleanTitle(title) ?? 'New chat', cleanModelId(modelId), modality],
    );
    res.status(201).json({ chat: publicChat(rows[0]) });
  } catch (err) {
    console.error('[chats] create failed:', err.message);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

// Fetch a single chat (owner only).
chatsRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, model_id, modality, created_at, updated_at
         FROM chats WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.session.userId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Chat not found' });
    res.json({ chat: publicChat(rows[0]) });
  } catch (err) {
    // Invalid UUID etc. — treat as not found rather than a 500.
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    console.error('[chats] get failed:', err.message);
    res.status(500).json({ error: 'Failed to load chat' });
  }
});

// Update title / model_id / modality. Only provided fields change.
chatsRouter.patch('/:id', async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;

  if ('title' in body) {
    sets.push(`title = $${i++}`);
    vals.push(cleanTitle(body.title));
  }
  if ('modelId' in body) {
    sets.push(`model_id = $${i++}`);
    vals.push(cleanModelId(body.modelId));
  }
  if ('modality' in body) {
    if (!MODALITIES.includes(body.modality)) {
      return res.status(400).json({ error: `modality must be one of: ${MODALITIES.join(', ')}` });
    }
    sets.push(`modality = $${i++}`);
    vals.push(body.modality);
  }

  if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });
  sets.push('updated_at = now()');

  vals.push(req.params.id, req.session.userId);
  try {
    const { rows } = await pool.query(
      `UPDATE chats SET ${sets.join(', ')}
        WHERE id = $${i++} AND user_id = $${i}
        RETURNING id, title, model_id, modality, created_at, updated_at`,
      vals,
    );
    if (!rows.length) return res.status(404).json({ error: 'Chat not found' });
    res.json({ chat: publicChat(rows[0]) });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    console.error('[chats] update failed:', err.message);
    res.status(500).json({ error: 'Failed to update chat' });
  }
});

// ── messages (thread + send) ────────────────────────────────────────────────
chatsRouter.get('/:id/messages', listMessages);
chatsRouter.post('/:id/messages', uploadAttachments, sendMessage);

// Delete a chat (cascades to its messages via the FK).
chatsRouter.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM chats WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId],
    );
    if (!rowCount) return res.status(404).json({ error: 'Chat not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    console.error('[chats] delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});
