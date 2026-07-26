import { pool } from '../db.js';
import { config } from '../config.js';
import { getDecryptedKey } from '../keys/service.js';
import {
  generateImages,
  extractImages,
  modelImagePricing,
  classifyError,
  errorMessage,
} from '../openrouter/client.js';
import { writeUserFile, deleteRef } from '../storage/local.js';
import { loadOwnedChat, mediaView } from './completion.js';

// Fetch the bytes for one normalized image ({ b64 } or { url }). OpenRouter
// output URLs are NOT assumed durable, so we fetch immediately (bible:
// output-persistence assumption).
async function bytesFor(img) {
  if (img.b64) {
    return { buffer: Buffer.from(img.b64, 'base64'), mimetype: img.mime || 'image/png' };
  }
  if (img.url) {
    const r = await fetch(img.url);
    if (!r.ok) throw new Error(`Failed to fetch generated image (HTTP ${r.status})`);
    const buffer = Buffer.from(await r.arrayBuffer());
    const mimetype = (r.headers.get('content-type') || img.mime || 'image/png').split(';')[0];
    return { buffer, mimetype };
  }
  throw new Error('No image data in response');
}

// Load a persisted assistant message + its attachments (for idempotent replays).
async function messageWithAttachments(messageId) {
  const { rows } = await pool.query(
    `SELECT id, role, content, content_type, cost_usd FROM messages WHERE id = $1`,
    [messageId],
  );
  if (!rows.length) return null;
  const media = await pool.query(
    `SELECT id, direction, size_bytes, file_ref FROM media_files WHERE message_id = $1 ORDER BY created_at ASC`,
    [messageId],
  );
  return {
    id: rows[0].id,
    role: rows[0].role,
    content: rows[0].content,
    contentType: rows[0].content_type,
    costUsd: rows[0].cost_usd,
    attachments: media.rows.map(mediaView),
  };
}

// POST /api/chats/:id/images — generate an image from a prompt, store the bytes
// locally as output media, and return the assistant message. Synchronous (the
// Unified Image API returns the image directly), guarded against duplicate spend
// by a per-chat pending lock (the partial unique index from migration 003).
export async function generateImage(req, res) {
  const userId = req.session.userId;
  const { prompt, idempotencyKey } = req.body || {};

  let chat;
  try {
    chat = await loadOwnedChat(req.params.id, userId);
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    throw err;
  }
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const text = String(prompt || '').trim();
  if (!text) return res.status(400).json({ error: 'A prompt is required.' });
  if (chat.modality !== 'image') {
    return res.status(400).json({ error: 'This chat is not an image chat.', category: 'model' });
  }
  if (!chat.model_id) {
    return res.status(400).json({ error: 'Choose an image model first.', category: 'model' });
  }

  // Idempotent replay: same key already produced (or is producing) a result.
  if (idempotencyKey) {
    const existing = await pool.query(
      `SELECT id, metadata ->> 'status' AS status FROM messages
        WHERE chat_id = $1 AND role = 'assistant' AND metadata ->> 'idempotencyKey' = $2
        LIMIT 1`,
      [chat.id, String(idempotencyKey)],
    );
    if (existing.rows.length) {
      if (existing.rows[0].status === 'pending') {
        return res.status(409).json({ error: 'This generation is already in progress.', category: 'pending' });
      }
      return res.json({ message: await messageWithAttachments(existing.rows[0].id) });
    }
  }

  const key = await getDecryptedKey(userId);
  if (!key) {
    return res.status(400).json({ error: 'Add your OpenRouter API key in Settings before generating.', category: 'key' });
  }

  // Pre-flight storage check: don't spend if we've no room to keep the result.
  const { rows: u0 } = await pool.query('SELECT storage_used_bytes FROM users WHERE id = $1', [userId]);
  if (Number(u0[0].storage_used_bytes) >= config.maxLocalBytes) {
    return res.status(400).json({ error: 'You are at your 5 GB local storage limit. Delete some media first.', category: 'storage' });
  }

  // Create the user prompt + a pending assistant row atomically. The partial
  // unique index refuses a second pending row for this chat (duplicate-spend
  // guard), surfaced as 409.
  let userMsgId;
  let assistantId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const um = await client.query(
      `INSERT INTO messages (chat_id, role, content, content_type) VALUES ($1, 'user', $2, 'text') RETURNING id`,
      [chat.id, text],
    );
    userMsgId = um.rows[0].id;
    const am = await client.query(
      `INSERT INTO messages (chat_id, role, content, content_type, metadata)
       VALUES ($1, 'assistant', NULL, 'image', $2::jsonb) RETURNING id`,
      [chat.id, JSON.stringify({ status: 'pending', model: chat.model_id, idempotencyKey: idempotencyKey || null })],
    );
    assistantId = am.rows[0].id;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A generation is already in progress in this chat.', category: 'pending' });
    }
    console.error('[imagegen] setup failed:', err.message);
    return res.status(500).json({ error: 'Failed to start generation.' });
  }
  client.release();

  // Clean up the pending assistant row on any failure so the chat isn't stuck.
  const fail = async (status, body) => {
    await pool.query('DELETE FROM messages WHERE id = $1', [assistantId]).catch(() => {});
    return res.status(status).json({ ...body, userMessageId: userMsgId });
  };

  let orRes;
  try {
    orRes = await generateImages({ key, model: chat.model_id, prompt: text });
  } catch {
    return fail(502, { error: 'Could not reach OpenRouter. Try again shortly.', category: 'model' });
  }

  if (!orRes.ok) {
    let orError = null;
    try { orError = (await orRes.json())?.error; } catch { /* non-JSON */ }
    const status = orRes.status >= 400 && orRes.status < 600 ? orRes.status : 502;
    return fail(status, { error: errorMessage(orError, `OpenRouter returned HTTP ${orRes.status}.`), category: classifyError(orRes.status, orError) });
  }

  let json;
  try { json = await orRes.json(); } catch { return fail(502, { error: 'OpenRouter returned an unreadable response.', category: 'model' }); }

  const images = extractImages(json);
  if (!images.length) {
    return fail(502, { error: 'The model returned no image.', category: 'model' });
  }

  // Fetch + write every returned image to local storage.
  const written = [];
  try {
    for (const img of images) {
      const { buffer, mimetype } = await bytesFor(img);
      const { fileRef, sizeBytes } = await writeUserFile(userId, { buffer, mimetype, originalname: 'generated' });
      written.push({ fileRef, sizeBytes });
    }
  } catch (err) {
    await Promise.all(written.map((w) => deleteRef(w.fileRef)));
    console.error('[imagegen] fetch/store failed:', err.message);
    return fail(502, { error: 'The image was generated but could not be saved. Please retry.', category: 'model' });
  }

  // Cost: prefer OpenRouter usage.cost. Only fall back to the catalogue price
  // when it's actually billed per image — a per-megapixel rate can't be turned
  // into a total without the output dimensions, so leave it null rather than wrong.
  let cost = json?.usage?.cost ?? null;
  if (cost == null) {
    const pr = await modelImagePricing(chat.model_id).catch(() => null);
    if (pr && (pr.unit === 'image' || pr.unit === 'images')) cost = pr.cost * written.length;
  }

  // Finalize: media rows + counter + mark the message complete, atomically.
  try {
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      for (const w of written) {
        await c2.query(
          `INSERT INTO media_files (message_id, direction, storage_location, file_ref, size_bytes)
           VALUES ($1, 'output', 'local', $2, $3)`,
          [assistantId, w.fileRef, w.sizeBytes],
        );
      }
      await c2.query(
        `UPDATE messages SET metadata = jsonb_set(metadata, '{status}', '"complete"'), cost_usd = $2 WHERE id = $1`,
        [assistantId, cost],
      );
      const total = written.reduce((n, w) => n + w.sizeBytes, 0);
      await c2.query('UPDATE users SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2', [total, userId]);
      await c2.query('UPDATE chats SET updated_at = now() WHERE id = $1', [chat.id]);
      await c2.query('COMMIT');
    } catch (err) {
      await c2.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c2.release();
    }
  } catch (err) {
    await Promise.all(written.map((w) => deleteRef(w.fileRef)));
    console.error('[imagegen] finalize failed:', err.message);
    return fail(500, { error: 'Failed to save the generated image.', category: 'request' });
  }

  return res.json({ userMessageId: userMsgId, message: await messageWithAttachments(assistantId) });
}
