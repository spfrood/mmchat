import { pool } from '../db.js';
import { getDecryptedKey } from '../keys/service.js';
import {
  chatCompletionStream,
  classifyError,
  errorMessage,
} from '../openrouter/client.js';

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
    data_collection: privacy ? 'deny' : 'allow',
  };
}

async function loadOwnedChat(chatId, userId) {
  const { rows } = await pool.query(
    `SELECT id, title, model_id, modality FROM chats WHERE id = $1 AND user_id = $2`,
    [chatId, userId],
  );
  return rows[0] || null;
}

// GET /api/chats/:id/messages — the persisted thread.
export async function listMessages(req, res) {
  try {
    const chat = await loadOwnedChat(req.params.id, req.session.userId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const { rows } = await pool.query(
      `SELECT id, role, content, content_type, cost_usd, created_at
         FROM messages WHERE chat_id = $1 ORDER BY created_at ASC`,
      [chat.id],
    );
    res.json({
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        contentType: m.content_type,
        costUsd: m.cost_usd,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    console.error('[messages] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
}

// POST /api/chats/:id/messages — persist the user turn, call OpenRouter with
// streaming, relay tokens to the client over SSE, then persist the assistant
// turn. Pre-flight problems (no model, no key, immediate OpenRouter rejection)
// come back as a normal JSON error with a `category`; once the stream starts,
// any later failure is delivered as an SSE {type:'error'} event.
export async function sendMessage(req, res) {
  const userId = req.session.userId;
  const { content, sort, privacy } = req.body || {};

  let chat;
  try {
    chat = await loadOwnedChat(req.params.id, userId);
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    throw err;
  }
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const text = String(content || '').trim();
  if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
  if (chat.modality !== 'text') {
    return res.status(400).json({ error: 'Only text chats can send messages yet.', category: 'model' });
  }
  if (!chat.model_id) {
    return res.status(400).json({ error: 'Select a model first.', category: 'model' });
  }

  const key = await getDecryptedKey(userId);
  if (!key) {
    return res.status(400).json({
      error: 'Add your OpenRouter API key in Settings before sending.',
      category: 'key',
    });
  }

  // Persist the user turn immediately so a reload shows it even if the model
  // call then fails.
  const userMsg = await pool.query(
    `INSERT INTO messages (chat_id, role, content, content_type)
     VALUES ($1, 'user', $2, 'text') RETURNING id, created_at`,
    [chat.id, text],
  );

  // Assemble the conversation to send (full thread, oldest first).
  const thread = await pool.query(
    `SELECT role, content FROM messages
      WHERE chat_id = $1 AND content IS NOT NULL AND role IN ('system','user','assistant')
      ORDER BY created_at ASC`,
    [chat.id],
  );
  const messages = thread.rows.map((m) => ({ role: m.role, content: m.content }));

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

  // Immediate rejection (bad key, no credits, unknown model…): still JSON.
  if (!orRes.ok) {
    let orError = null;
    try { orError = (await orRes.json())?.error; } catch { /* non-JSON body */ }
    const category = classifyError(orRes.status, orError);
    const message = errorMessage(orError, `OpenRouter returned HTTP ${orRes.status}.`);
    const status = orRes.status >= 400 && orRes.status < 600 ? orRes.status : 502;
    return res.status(status).json({ error: message, category, userMessageId: userMsg.rows[0].id });
  }

  // ── streaming path ──
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // don't let nginx buffer the stream
  res.flushHeaders?.();

  sse(res, { type: 'user', id: userMsg.rows[0].id, createdAt: userMsg.rows[0].created_at });

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
        if (!line.startsWith('data:')) continue; // skip ':' keep-alive comments
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

  // Client went away mid-stream: persist what we have, then stop.
  if (controller.signal.aborted) {
    if (assistant) await persistAssistant(chat.id, assistant, usage, chat.model_id).catch(() => {});
    return res.end();
  }

  if (streamErr) {
    // Save any partial text so it isn't lost, then report the error inline.
    let savedId = null;
    if (assistant) {
      savedId = await persistAssistant(chat.id, assistant, usage, chat.model_id).catch(() => null);
    }
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
