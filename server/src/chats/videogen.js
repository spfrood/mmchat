import { pool } from '../db.js';
import { config } from '../config.js';
import { getDecryptedKey } from '../keys/service.js';
import {
  submitVideo,
  getVideoJob,
  fetchVideoContent,
  extractVideoUrls,
  videoStatus,
  modelVideoPrice,
  classifyError,
  errorMessage,
} from '../openrouter/client.js';
import { resolveOutputTarget, persistGeneratedOutput } from '../storage/output.js';
import { loadOwnedChat, mediaView } from './completion.js';

// Video generation is ASYNCHRONOUS (bible: OpenRouter's /videos endpoint submits
// a job, then completion is polled). Confirmed against current OpenRouter docs:
//   POST /videos            -> 202 { id, polling_url, status }
//   GET  /videos/{id}       -> { status, unsigned_urls?, usage?, error? }
//   GET  unsigned_urls[i]   -> the video bytes (needs the bearer key)
// We store the assistant message in a 'pending' state with the job id in
// metadata and NEVER block the request waiting for the job. Completion is driven
// by the reconcile endpoint below, which the client polls while a job is in
// flight AND calls on chat load — so a closed tab or missed event still resolves.

// Load one message + its output media as the client-facing view.
async function loadMessageView(messageId) {
  const { rows } = await pool.query(
    `SELECT id, role, content, content_type, cost_usd, created_at,
            metadata ->> 'status'    AS status,
            metadata ->> 'error'     AS error,
            metadata ->> 'jobStatus' AS job_status
       FROM messages WHERE id = $1`,
    [messageId],
  );
  if (!rows.length) return null;
  const media = await pool.query(
    `SELECT id, direction, size_bytes, file_ref, content_type, storage_location, unavailable_at
       FROM media_files WHERE message_id = $1 ORDER BY created_at ASC`,
    [messageId],
  );
  const r = rows[0];
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    contentType: r.content_type,
    costUsd: r.cost_usd,
    status: r.status,
    error: r.error,
    jobStatus: r.job_status,
    createdAt: r.created_at,
    attachments: media.rows.map(mediaView),
  };
}

// Mark a pending video message failed, stashing a short user-facing reason.
async function markFailed(messageId, message) {
  await pool
    .query(
      `UPDATE messages SET metadata = jsonb_set(metadata || $2::jsonb, '{status}', '"failed"') WHERE id = $1`,
      [messageId, JSON.stringify({ error: String(message).slice(0, 500) })],
    )
    .catch(() => {});
}

// POST /api/chats/:id/videos — submit an async video job. Returns immediately
// with a pending assistant message; the client polls /videos/reconcile to finish.
export async function submitVideoJob(req, res) {
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
  if (chat.modality !== 'video') {
    return res.status(400).json({ error: 'This chat is not a video chat.', category: 'model' });
  }
  if (!chat.model_id) {
    return res.status(400).json({ error: 'Choose a video model first.', category: 'model' });
  }

  // Idempotent replay: same key already submitted — return that message as-is.
  if (idempotencyKey) {
    const existing = await pool.query(
      `SELECT id FROM messages
        WHERE chat_id = $1 AND role = 'assistant' AND metadata ->> 'idempotencyKey' = $2
        LIMIT 1`,
      [chat.id, String(idempotencyKey)],
    );
    if (existing.rows.length) {
      return res.json({ message: await loadMessageView(existing.rows[0].id) });
    }
  }

  const key = await getDecryptedKey(userId);
  if (!key) {
    return res.status(400).json({ error: 'Add your OpenRouter API key in Settings before generating.', category: 'key' });
  }

  // Pre-flight storage check: don't spend if there's no room to keep the result.
  // Only applies when output lands locally — a linked cloud folder doesn't count
  // against the 5 GB cap.
  const target = await resolveOutputTarget(userId);
  if (target.kind === 'local') {
    const { rows: u0 } = await pool.query('SELECT storage_used_bytes FROM users WHERE id = $1', [userId]);
    if (Number(u0[0].storage_used_bytes) >= config.maxLocalBytes) {
      return res.status(400).json({ error: 'You are at your 5 GB local storage limit. Delete some media first.', category: 'storage' });
    }
  }

  // Create the user prompt + a pending assistant row atomically. A per-user
  // advisory lock serializes concurrent submits so the concurrent-video cap
  // can't be raced past; the per-chat partial unique index (migration 003)
  // additionally refuses two pending generations in the same chat.
  let userMsgId;
  let assistantId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`video:${userId}`]);
    const { rows: cnt } = await client.query(
      `SELECT count(*)::int AS n FROM messages m
         JOIN chats c ON c.id = m.chat_id
        WHERE c.user_id = $1 AND m.role = 'assistant' AND m.content_type = 'video'
          AND (m.metadata ->> 'status') = 'pending'`,
      [userId],
    );
    if (cnt[0].n >= config.maxConcurrentVideos) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(429).json({
        error: `You already have ${cnt[0].n} video job(s) generating. Wait for one to finish before starting another.`,
        category: 'pending',
      });
    }
    // clock_timestamp() (not the shared transaction now()) so the user turn
    // sorts strictly before its assistant reply within this one transaction.
    const um = await client.query(
      `INSERT INTO messages (chat_id, role, content, content_type, created_at)
       VALUES ($1, 'user', $2, 'text', clock_timestamp()) RETURNING id`,
      [chat.id, text],
    );
    userMsgId = um.rows[0].id;
    const am = await client.query(
      `INSERT INTO messages (chat_id, role, content, content_type, metadata, created_at)
       VALUES ($1, 'assistant', NULL, 'video', $2::jsonb, clock_timestamp()) RETURNING id`,
      [chat.id, JSON.stringify({
        status: 'pending', jobStatus: 'submitting', model: chat.model_id,
        idempotencyKey: idempotencyKey || null, jobId: null,
      })],
    );
    assistantId = am.rows[0].id;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A generation is already in progress in this chat.', category: 'pending' });
    }
    console.error('[videogen] setup failed:', err.message);
    return res.status(500).json({ error: 'Failed to start generation.' });
  }
  client.release();

  // Clean up the pending assistant row on any submit failure so nothing's stuck.
  const fail = async (status, body) => {
    await pool.query('DELETE FROM messages WHERE id = $1', [assistantId]).catch(() => {});
    return res.status(status).json({ ...body, userMessageId: userMsgId });
  };

  let orRes;
  try {
    orRes = await submitVideo({ key, model: chat.model_id, prompt: text });
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

  const jobId = json?.id || json?.job_id || null;
  if (!jobId) return fail(502, { error: 'OpenRouter did not return a video job id.', category: 'model' });

  await pool.query(
    `UPDATE messages SET metadata = metadata || $2::jsonb WHERE id = $1`,
    [assistantId, JSON.stringify({
      jobId,
      pollingUrl: json?.polling_url || null,
      jobStatus: json?.status || 'pending',
      status: 'pending',
    })],
  );
  await pool.query('UPDATE chats SET updated_at = now() WHERE id = $1', [chat.id]);

  return res.json({ userMessageId: userMsgId, message: await loadMessageView(assistantId) });
}

// POST /api/chats/:id/videos/reconcile — re-check every still-pending video job
// in this chat against OpenRouter and finalize any that finished. Safe to call
// repeatedly (client polls it) and on chat load. Never throws on one job's
// failure — each is isolated so a single bad job can't stall the others.
export async function reconcileVideos(req, res) {
  const userId = req.session.userId;

  let chat;
  try {
    chat = await loadOwnedChat(req.params.id, userId);
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Chat not found' });
    throw err;
  }
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const { rows: pending } = await pool.query(
    `SELECT id, metadata ->> 'jobId' AS job_id, metadata ->> 'pollingUrl' AS polling_url
       FROM messages
      WHERE chat_id = $1 AND role = 'assistant' AND content_type = 'video'
        AND (metadata ->> 'status') = 'pending'
      ORDER BY created_at ASC`,
    [chat.id],
  );
  if (!pending.length) return res.json({ messages: [] });

  const key = await getDecryptedKey(userId);
  const out = [];
  for (const row of pending) {
    try {
      out.push(await reconcileOne(userId, chat, row, key));
    } catch (err) {
      console.error('[videogen] reconcile failed for', row.id, err.message);
      out.push(await loadMessageView(row.id)); // return current (unchanged) state
    }
  }
  return res.json({ messages: out.filter(Boolean) });
}

async function reconcileOne(userId, chat, row, key) {
  if (!row.job_id) {
    await markFailed(row.id, 'The video job was not submitted. Please try again.');
    return loadMessageView(row.id);
  }
  // No key to poll with (user removed it): leave pending, try again later.
  if (!key) return loadMessageView(row.id);

  let orRes;
  try {
    orRes = await getVideoJob({ key, jobId: row.job_id, pollingUrl: row.polling_url });
  } catch {
    return loadMessageView(row.id); // transient network error — retry next poll
  }

  if (!orRes.ok) {
    if (orRes.status === 404) await markFailed(row.id, 'The video job expired or was not found.');
    else if (orRes.status === 401 || orRes.status === 403) await markFailed(row.id, 'Your API key was rejected while checking the job.');
    // other statuses: leave pending, retry next poll
    return loadMessageView(row.id);
  }

  let json;
  try { json = await orRes.json(); } catch { return loadMessageView(row.id); }

  const st = videoStatus(json);
  // Keep the raw provider status visible in the UI ("in_progress" etc.).
  await pool
    .query(`UPDATE messages SET metadata = metadata || $2::jsonb WHERE id = $1`, [row.id, JSON.stringify({ jobStatus: json?.status || null })])
    .catch(() => {});

  if (st === 'pending') return loadMessageView(row.id);

  if (st === 'failed') {
    const raw = json?.error?.message || json?.error || 'The video generation failed.';
    await markFailed(row.id, typeof raw === 'string' ? raw : 'The video generation failed.');
    return loadMessageView(row.id);
  }

  // completed → fetch bytes immediately (URLs are not assumed durable) and persist.
  const urls = extractVideoUrls(json);
  if (!urls.length) {
    await markFailed(row.id, 'The job completed but returned no video.');
    return loadMessageView(row.id);
  }

  // Download every returned video (URLs aren't durable; the download needs the
  // bearer key). A transient failure here leaves the message pending so a later
  // reconcile can retry.
  let buffers;
  try {
    buffers = [];
    for (const url of urls) {
      const r = await fetchVideoContent({ key, url });
      if (!r.ok) throw new Error(`content HTTP ${r.status}`);
      const buffer = Buffer.from(await r.arrayBuffer());
      const mimetype = (r.headers.get('content-type') || 'video/mp4').split(';')[0];
      buffers.push({ buffer, mimetype });
    }
  } catch (err) {
    console.error('[videogen] download failed:', err.message);
    return loadMessageView(row.id);
  }

  // Cost: prefer OpenRouter's reported usage.cost, else the model's per-video price.
  let cost = json?.usage?.cost ?? null;
  if (cost == null) {
    const per = await modelVideoPrice(chat.model_id).catch(() => null);
    if (per != null) cost = per;
  }

  // Persist to the resolved target (cloud folder or local disk). A failure here
  // (e.g. a cloud upload error) is treated as transient: leave the message
  // pending and let the next reconcile retry, rather than marking it failed.
  try {
    await persistGeneratedOutput({ userId, messageId: row.id, chatId: chat.id, buffers, cost });
  } catch (err) {
    console.error('[videogen] persist failed:', err.message);
    return loadMessageView(row.id);
  }
  return loadMessageView(row.id);
}
