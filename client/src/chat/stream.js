import { ApiError } from '../api.js';

// POST a message and consume the streamed reply. The endpoint returns either a
// normal JSON error (pre-flight / immediate OpenRouter rejection) — surfaced as
// an ApiError whose .data.category drives the UI — or an SSE stream of events:
//   { type: 'user',  id, createdAt }        the persisted user turn
//   { type: 'delta', text }                 an incremental chunk of the reply
//   { type: 'error', category, message, messageId }
//   { type: 'done',  messageId, cost }
export async function streamMessage(chatId, body, handlers = {}) {
  const res = await fetch(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });

  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || res.statusText, res.status, data);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'user') handlers.onUser?.(evt);
      else if (evt.type === 'delta') handlers.onDelta?.(evt.text);
      else if (evt.type === 'error') handlers.onError?.(evt);
      else if (evt.type === 'done') handlers.onDone?.(evt);
    }
  }
}
