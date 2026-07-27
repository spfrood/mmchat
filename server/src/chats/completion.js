import { pool } from '../db.js';
import { config } from '../config.js';
import { getDecryptedKey } from '../keys/service.js';
import {
  chatCompletionStream,
  classifyError,
  errorMessage,
  modelSupportsImageInput,
} from '../openrouter/client.js';
import { writeInputFile, deleteRef, isSupportedImage, contentTypeFor } from '../storage/local.js';

// SSE helpers ────────────────────────────────────────────────────────────────
function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Build the provider-routing object from the UI toggles.
//   sort:    'price' (default) | 'speed'  -> provider.sort price|throughput
//   privacy: true                          -> provider.data_collection deny
function buildProvider({ sort, privacy }) {
  return {
    sort: sort === 'speed' ? 'throughput' : 'price',
    data_collection: truthy(privacy) ? 'deny' : 'allow',
  };
}

// FormData sends everything as strings ('true'/'false'); JSON sends booleans.
function truthy(v) {
  return v === true || v === 'true';
}

export async function loadOwnedChat(chatId, userId) {
  const { rows } = await pool.query(
    `SELECT id, title, model_id, modality FROM chats WHERE id = $1 AND user_id = $2`,
    [chatId, userId],
  );
  return rows[0] || null;
}

export function mediaView(m) {
  return {
    id: m.id,
    direction: m.direction,
    sizeBytes: Number(m.size_bytes),
    contentType: m.content_type || (m.file_ref ? contentTypeFor(m.file_ref) : undefined),
    storageLocation: m.storage_location,
    // Cloud file the user deleted on the provider side (out-of-band). The client
    // renders a "no longer in your cloud storage" placeholder instead of fetching.
    unavailable: Boolean(m.unavailable_at),
    url: `/api/media/${m.id}`,
  };
}

// GET /api/chats/:id/messages — the persisted thread, with input attachments.
export async function listMessages(req, res) {
  try {
    const chat = await loadOwnedChat(req.params.id, req.session.userId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const { rows } = await pool.query(
      `SELECT id, role, content, content_type, cost_usd, created_at,
              metadata ->> 'status' AS status
         FROM messages WHERE chat_id = $1
        ORDER BY created_at ASC, (role <> 'user') ASC`,
      [chat.id],
    );
    const ids = rows.map((m) => m.id);
    const byMsg = new Map();
    if (ids.length) {
      const media = await pool.query(
        `SELECT id, message_id, direction, size_bytes, file_ref,
                content_type, storage_location, unavailable_at
           FROM media_files WHERE message_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
        [ids],
      );
      for (const m of media.rows) {
        if (!byMsg.has(m.message_id)) byMsg.set(m.message_id, []);
        byMsg.get(m.message_id).push(mediaView(m));
      }
    }
    res.json({
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        contentType: m.content_type,
        costUsd: m.cost_usd,
        status: m.status,
        createdAt: m.created_at,
        attachments: byMsg.get(m.id) || [],
      })),
    });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    console.error('[messages] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
}

// Persist attachments for a just-created user message: write each file to local
// storage, insert media_files (direction 'input'), and bump the user's
// storage_used_bytes counter — all under one transaction. On failure, unlink
// any files already written. Returns the created media rows (for the response).
export async function persistAttachments(userId, messageId, files) {
  const written = [];
  try {
    for (const f of files) {
      const { fileRef, sizeBytes } = await writeInputFile(userId, f);
      written.push({ fileRef, sizeBytes, contentType: f.mimetype });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = [];
      for (const w of written) {
        const { rows } = await client.query(
          `INSERT INTO media_files (message_id, direction, storage_location, file_ref, size_bytes, content_type)
           VALUES ($1, 'input', 'local', $2, $3, $4)
           RETURNING id, direction, size_bytes, storage_location, content_type, unavailable_at`,
          [messageId, w.fileRef, w.sizeBytes, w.contentType],
        );
        created.push(rows[0]);
      }
      const total = written.reduce((n, w) => n + w.sizeBytes, 0);
      const { rows: u } = await client.query(
        `UPDATE users SET storage_used_bytes = storage_used_bytes + $1
          WHERE id = $2 RETURNING storage_used_bytes`,
        [total, userId],
      );
      await client.query('COMMIT');
      return { created, storageUsed: Number(u[0].storage_used_bytes) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    await Promise.all(written.map((w) => deleteRef(w.fileRef)));
    throw err;
  }
}

// POST /api/chats/:id/messages — persist the user turn (+ any image attachments),
// call OpenRouter with streaming, relay tokens over SSE, then persist the reply.
// Pre-flight problems come back as JSON with a `category`; once the stream
// starts, later failures arrive as an SSE {type:'error'} event.
export async function sendMessage(req, res) {
  const userId = req.session.userId;
  const { content, sort, privacy } = req.body || {};
  const files = Array.isArray(req.files) ? req.files : [];

  let chat;
  try {
    chat = await loadOwnedChat(req.params.id, userId);
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    throw err;
  }
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const text = String(content || '').trim();
  if (!text && !files.length) return res.status(400).json({ error: 'Message cannot be empty' });
  if (chat.modality !== 'text') {
    return res.status(400).json({ error: 'Only text chats can send messages yet.', category: 'model' });
  }
  if (!chat.model_id) {
    return res.status(400).json({ error: 'Select a model first.', category: 'model' });
  }

  // Attachment validation (before writing anything).
  if (files.length) {
    const bad = files.find((f) => !isSupportedImage(f.mimetype));
    if (bad) {
      return res.status(400).json({
        error: `Unsupported attachment type: ${bad.mimetype}. Attach an image (PNG, JPEG, WebP, GIF).`,
        category: 'request',
      });
    }
    let vision = false;
    try { vision = await modelSupportsImageInput(chat.model_id); } catch { vision = false; }
    if (!vision) {
      return res.status(400).json({
        error: 'This model does not accept image input. Choose a vision-capable model.',
        category: 'model',
      });
    }
    // Hard 5 GB cap.
    const incoming = files.reduce((n, f) => n + f.size, 0);
    const { rows: u } = await pool.query('SELECT storage_used_bytes FROM users WHERE id = $1', [userId]);
    if (Number(u[0].storage_used_bytes) + incoming > config.maxLocalBytes) {
      return res.status(400).json({
        error: 'This upload would exceed your 5 GB local storage limit. Delete some media first.',
        category: 'storage',
      });
    }
  }

  const key = await getDecryptedKey(userId);
  if (!key) {
    return res.status(400).json({
      error: 'Add your OpenRouter API key in Settings before sending.',
      category: 'key',
    });
  }

  // History (text) BEFORE inserting the new turn.
  const prior = await pool.query(
    `SELECT role, content FROM messages
      WHERE chat_id = $1 AND content IS NOT NULL AND role IN ('system','user','assistant')
      ORDER BY created_at ASC`,
    [chat.id],
  );
  const history = prior.rows.map((m) => ({ role: m.role, content: m.content }));

  // Persist the user turn (text) so a reload shows it even if the call fails.
  const userMsg = await pool.query(
    `INSERT INTO messages (chat_id, role, content, content_type)
     VALUES ($1, 'user', $2, 'text') RETURNING id, created_at`,
    [chat.id, text || null],
  );
  const userMsgId = userMsg.rows[0].id;

  // Write attachments + media rows.
  let attachments = [];
  let storageUsed = null;
  if (files.length) {
    try {
      const r = await persistAttachments(userId, userMsgId, files);
      attachments = r.created.map(mediaView);
      storageUsed = r.storageUsed;
    } catch (err) {
      console.error('[messages] attachment persist failed:', err.message);
      return res.status(500).json({ error: 'Failed to store the attachment.', category: 'request', userMessageId: userMsgId });
    }
  }

  // Build the outgoing current turn: multimodal content when images present.
  const currentContent = files.length
    ? [
        ...(text ? [{ type: 'text', text }] : []),
        ...files.map((f) => ({
          type: 'image_url',
          image_url: { url: `data:${f.mimetype};base64,${f.buffer.toString('base64')}` },
        })),
      ]
    : text;
  const messages = [...history, { role: 'user', content: currentContent }];

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let orRes;
  try {
    orRes = await chatCompletionStream({
      key,
      model: chat.model_id,
      messages,
      provider: buildProvider({ sort, privacy }),
      signal: controller.signal,
    });
  } catch (err) {
    return res.status(502).json({
      error: 'Could not reach OpenRouter. Check your connection and try again.',
      category: 'model',
    });
  }

  if (!orRes.ok) {
    let orError = null;
    try { orError = (await orRes.json())?.error; } catch { /* non-JSON body */ }
    const category = classifyError(orRes.status, orError);
    const message = errorMessage(orError, `OpenRouter returned HTTP ${orRes.status}.`);
    const status = orRes.status >= 400 && orRes.status < 600 ? orRes.status : 502;
    return res.status(status).json({ error: message, category, userMessageId: userMsgId });
  }

  // ── streaming path ──
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sse(res, {
    type: 'user',
    id: userMsgId,
    createdAt: userMsg.rows[0].created_at,
    attachments,
    storageUsed,
    storageNotice: storageUsed != null && storageUsed >= config.noticeLocalBytes,
  });

  let assistant = '';
  let usage = null;
  let streamErr = null;
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const reader = orRes.body.getReader();

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { done = true; break; }
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.error) { streamErr = evt.error; continue; }
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) {
          assistant += delta;
          sse(res, { type: 'delta', text: delta });
        }
        if (evt.usage) usage = evt.usage;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) streamErr = { message: err.message };
  }

  if (controller.signal.aborted) {
    if (assistant) await persistAssistant(chat.id, assistant, usage, chat.model_id).catch(() => {});
    return res.end();
  }

  if (streamErr) {
    let savedId = null;
    if (assistant) savedId = await persistAssistant(chat.id, assistant, usage, chat.model_id).catch(() => null);
    sse(res, {
      type: 'error',
      category: classifyError(200, streamErr),
      message: errorMessage(streamErr, 'The model stream ended unexpectedly.'),
      messageId: savedId,
    });
    return res.end();
  }

  const saved = await persistAssistant(chat.id, assistant, usage, chat.model_id);
  sse(res, { type: 'done', messageId: saved, cost: usage?.cost ?? null });
  res.end();
}

async function persistAssistant(chatId, content, usage, modelId) {
  const cost = usage && usage.cost != null ? usage.cost : null;
  const { rows } = await pool.query(
    `INSERT INTO messages (chat_id, role, content, content_type, cost_usd, metadata)
     VALUES ($1, 'assistant', $2, 'text', $3, $4::jsonb) RETURNING id`,
    [chatId, content, cost, JSON.stringify({ model: modelId, usage: usage || null })],
  );
  await pool.query('UPDATE chats SET updated_at = now() WHERE id = $1', [chatId]);
  return rows[0].id;
}
