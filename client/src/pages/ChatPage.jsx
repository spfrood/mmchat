import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useChats } from '../chat/ChatsContext.jsx';
import { useStorage } from '../chat/StorageContext.jsx';
import { streamMessage } from '../chat/stream.js';
import ModelPicker from '../chat/ModelPicker.jsx';
import VideoConfirm from '../chat/VideoConfirm.jsx';

const MODALITIES = ['text', 'image', 'video'];
const MAX_ATTACH = 6;

// Simple per-browser persistence for the provider-routing toggles.
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

// Format a per-reply cost (USD) for display; hidden when zero/unknown.
function fmtCost(c) {
  const n = Number(c);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
}

// Image price (USD per billing unit) → short label; null if unknown. Never
// exponential — a fixed, readable string.
function fmtPerImage(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n >= 0.0001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

// Short label for an image billing unit (e.g. "megapixel" → "MP").
function imgUnit(u) {
  if (!u) return 'image';
  const s = String(u).toLowerCase();
  if (s.includes('megapixel') || s === 'mp') return 'MP';
  if (s.includes('token')) return 'token';
  if (s.includes('image')) return 'image';
  return s;
}

// A comparable rate label, or null when there's no meaningful per-unit figure
// (per-token image pricing is metered — a tiny per-token number helps no one).
function imgRateLabel(cost, unit) {
  if (String(unit || '').toLowerCase().includes('token')) return null;
  const label = fmtPerImage(cost);
  return label ? `from ${label}/${imgUnit(unit)}` : null;
}

// Per-second video rate (USD) → short label with enough precision for tiny
// rates; null if unknown.
function fmtVideo(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n >= 0.0001) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(2)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ChatPage() {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const { chats, loading, updateChat, deleteChat, refresh, editingChatId, closeEditor } = useChats();
  const { refresh: refreshStorage } = useStorage();

  const chat = chats.find((c) => c.id === chatId);
  const editing = chat && editingChatId === chat.id;

  // thread + streaming
  const [messages, setMessages] = useState([]);
  const [msgsLoading, setMsgsLoading] = useState(true);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [error, setError] = useState(null); // { category, message }
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // attachments (image input) — array of { file, url, name, type }
  const [attachments, setAttachments] = useState([]);
  const [visionSupported, setVisionSupported] = useState(false);
  const fileInputRef = useRef(null);

  // image / video generation (image- and video-modality chats)
  const [generating, setGenerating] = useState(false);
  const [imagePrice, setImagePrice] = useState(null); // USD per image-unit for the model
  const [imageUnit, setImageUnit] = useState(null);   // billing unit (image | megapixel | …)
  const [videoPrice, setVideoPrice] = useState(null); // per-second USD for the model
  const [videoConfirm, setVideoConfirm] = useState(null); // { prompt } awaiting confirmation

  const isImage = chat?.modality === 'image';
  const isVideo = chat?.modality === 'video';
  const isText = chat?.modality === 'text';

  // provider routing
  const [sort, setSort] = useState(() => lsGet('mmchat.sort', 'price'));
  const [privacy, setPrivacy] = useState(() => lsGet('mmchat.privacy', false));
  useEffect(() => lsSet('mmchat.sort', sort), [sort]);
  useEffect(() => lsSet('mmchat.privacy', privacy), [privacy]);

  // editor fields (title/modality/delete — opened from the sidebar ⋯ menu)
  const [title, setTitle] = useState('');
  const [modality, setModality] = useState('text');
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState('');

  const threadRef = useRef(null);

  // Load the persisted thread whenever the routed chat changes.
  useEffect(() => {
    if (!chatId) return;
    let alive = true;
    setMsgsLoading(true);
    setError(null);
    setStreamingText('');
    api(`/chats/${chatId}/messages`)
      .then((res) => { if (alive) setMessages(res.messages); })
      .catch(() => { if (alive) setMessages([]); })
      .finally(() => { if (alive) setMsgsLoading(false); });
    return () => { alive = false; };
  }, [chatId]);

  useEffect(() => {
    if (chat) { setTitle(chat.title || ''); setModality(chat.modality); setEditErr(''); }
  }, [chat?.id, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Model capabilities: gates the attach control (vision) and surfaces the
  // per-image price for the image-mode cost note.
  useEffect(() => {
    if (!chat?.modelId) { setVisionSupported(false); setImagePrice(null); setImageUnit(null); setVideoPrice(null); return; }
    let alive = true;
    api(`/models/capabilities?id=${encodeURIComponent(chat.modelId)}`)
      .then((r) => { if (alive) { setVisionSupported(!!r.supportsImageInput); setImagePrice(r.imagePrice ?? null); setImageUnit(r.imageUnit ?? null); setVideoPrice(r.videoPrice ?? null); } })
      .catch(() => { if (alive) { setVisionSupported(false); setImagePrice(null); setImageUnit(null); setVideoPrice(null); } });
    return () => { alive = false; };
  }, [chat?.modelId]);

  // Clear staged attachments when switching chats.
  useEffect(() => { setAttachments([]); }, [chatId]);

  // Video reconciliation: video jobs are async, so any persisted message still
  // in 'pending' gets its status re-checked against OpenRouter — once on load and
  // then on an interval while the tab is open (covers a closed tab / missed
  // event). Keyed on the set of real (persisted) pending ids so the interval
  // isn't torn down on every unrelated re-render, and stops once none are left.
  const pendingVideoKey = messages
    .filter((m) => m.role === 'assistant' && m.status === 'pending' && m.contentType === 'video' && UUID_RE.test(String(m.id)))
    .map((m) => m.id)
    .join(',');
  // A video job is in flight in THIS chat — a submitted-but-pending one counts,
  // not just the brief async submit. Gates the composer so a reload or the
  // minutes-long generation can't fire a second (the backend 409s it either way).
  const videoPending = pendingVideoKey.length > 0;
  useEffect(() => {
    if (!pendingVideoKey) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await api(`/chats/${chatId}/videos/reconcile`, { method: 'POST', body: {} });
        if (!alive || !res.messages?.length) return;
        setMessages((m) => m.map((x) => {
          const upd = res.messages.find((r) => r.id === x.id);
          return upd ? { ...x, ...upd } : x;
        }));
        // A completed job wrote its video to local storage — resync the counter.
        refreshStorage();
      } catch { /* transient — try again next tick */ }
    };
    tick();
    const iv = setInterval(tick, 12000);
    return () => { alive = false; clearInterval(iv); };
  }, [chatId, pendingVideoKey, refreshStorage]);

  // Keep the thread scrolled to the newest content.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText]);

  if (loading && !chat) return <p className="muted pad">Loading…</p>;
  if (!chat) {
    return (
      <div className="pane-empty">
        <h1>Chat not found</h1>
        <p className="muted">It may have been deleted.</p>
      </div>
    );
  }

  const dirty = title !== (chat.title || '') || modality !== chat.modality;

  async function saveEditor() {
    setEditErr('');
    setSaving(true);
    try {
      await updateChat(chat.id, { title, modality });
      closeEditor();
    } catch (err) {
      setEditErr(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function removeChat() {
    if (!window.confirm('Delete this chat? This cannot be undone.')) return;
    try {
      await deleteChat(chat.id);
      refreshStorage(); // deleting a chat frees any local media it held
      navigate('/');
    } catch (err) {
      setEditErr(err.message || 'Failed to delete');
    }
  }

  async function pickModel(model) {
    try {
      await updateChat(chat.id, { modelId: model.id });
    } catch (err) {
      setError({ category: 'request', message: err.message || 'Failed to set model' });
    }
  }

  function onPickFiles(e) {
    const chosen = Array.from(e.target.files || []);
    e.target.value = ''; // let the same file be re-picked later
    if (!chosen.length) return;
    const images = chosen.filter((f) => f.type.startsWith('image/'));
    const room = Math.max(0, MAX_ATTACH - attachments.length);
    const next = images.slice(0, room).map((f) => ({ file: f, url: URL.createObjectURL(f), name: f.name, type: f.type }));
    setAttachments((a) => [...a, ...next]);
    if (images.length < chosen.length) {
      setError({ category: 'request', message: 'Only image files can be attached.' });
    }
  }

  function removeAttachment(idx) {
    setAttachments((a) => {
      const removed = a[idx];
      if (removed) URL.revokeObjectURL(removed.url);
      return a.filter((_, i) => i !== idx);
    });
  }

  async function send() {
    if (streaming) return;
    const content = input.trim();
    const files = attachments;
    if (!content && files.length === 0) return;
    if (chat.modality !== 'text') {
      setError({ category: 'model', message: 'Only text chats can send messages yet.' });
      return;
    }
    if (!chat.modelId) {
      setError({ category: 'model', message: 'Choose a model first.' });
      return;
    }
    if (files.length && !visionSupported) {
      setError({ category: 'model', message: 'This model does not accept image input. Choose a vision-capable model.' });
      return;
    }
    setError(null);

    // Optimistic bubble reuses the local preview URLs (kept valid this session).
    const previews = files.map((a) => ({ url: a.url, contentType: a.type, name: a.name }));
    setInput('');
    setAttachments([]);
    const tempId = `temp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: 'user', content, attachments: previews }]);
    setStreaming(true);
    setStreamingText('');
    let acc = '';

    let body;
    if (files.length) {
      body = new FormData();
      body.append('content', content);
      body.append('sort', sort);
      body.append('privacy', String(privacy));
      for (const a of files) body.append('files', a.file);
    } else {
      body = { content, sort, privacy };
    }

    try {
      await streamMessage(chat.id, body, {
        onUser: (e) => setMessages((m) => m.map((x) => (
          x.id === tempId
            ? { ...x, id: e.id, attachments: e.attachments?.length ? e.attachments : x.attachments }
            : x
        ))),
        onDelta: (t) => { acc += t; setStreamingText(acc); },
        onError: (e) => {
          setError({ category: e.category, message: e.message });
          if (e.messageId && acc) setMessages((m) => [...m, { id: e.messageId, role: 'assistant', content: acc }]);
        },
        onDone: (e) => {
          if (acc) setMessages((m) => [...m, { id: e.messageId, role: 'assistant', content: acc, costUsd: e.cost }]);
        },
      });
    } catch (err) {
      setError({ category: err.data?.category || 'request', message: err.message });
    } finally {
      setStreaming(false);
      setStreamingText('');
      refresh(); // re-sort the sidebar by recency
      refreshStorage(); // an image attachment may have changed local usage
    }
  }

  // Image-modality chats: one-shot generation (no streaming). The submit button
  // is disabled while in flight, and each submit carries an idempotency key so a
  // reload-refire against the same pending message is refused by the backend.
  async function generateImage() {
    if (generating) return;
    const prompt = input.trim();
    if (!prompt) return;
    if (!chat.modelId) {
      setError({ category: 'model', message: 'Choose an image model first.' });
      return;
    }
    setError(null);
    setInput('');
    const key = crypto.randomUUID();
    const tempUser = `temp-${Date.now()}`;
    const tempAsst = `pending-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: tempUser, role: 'user', content: prompt },
      { id: tempAsst, role: 'assistant', content: null, status: 'pending', contentType: 'image' },
    ]);
    setGenerating(true);
    try {
      const res = await api(`/chats/${chat.id}/images`, { method: 'POST', body: { prompt, idempotencyKey: key } });
      setMessages((m) => m
        .map((x) => (x.id === tempUser ? { ...x, id: res.userMessageId || x.id } : x))
        .map((x) => (x.id === tempAsst ? res.message : x)));
    } catch (err) {
      setError({ category: err.data?.category || 'model', message: err.message });
      setMessages((m) => m.filter((x) => x.id !== tempAsst)); // drop the pending placeholder
    } finally {
      setGenerating(false);
      refresh();
      refreshStorage(); // a generated image was written to local storage
    }
  }

  // Video-modality chats: async generation, gated behind a confirmation dialog
  // (real spend). requestVideo opens the dialog; confirmVideo actually submits.
  function requestVideo() {
    if (generating || videoPending) return;
    const prompt = input.trim();
    if (!prompt) return;
    if (!chat.modelId) {
      setError({ category: 'model', message: 'Choose a video model first.' });
      return;
    }
    setError(null);
    setVideoConfirm({ prompt });
  }

  async function confirmVideo() {
    const prompt = videoConfirm?.prompt?.trim();
    setVideoConfirm(null);
    if (!prompt) return;
    setInput('');
    const key = crypto.randomUUID();
    const tempUser = `temp-${Date.now()}`;
    const tempAsst = `pending-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: tempUser, role: 'user', content: prompt },
      { id: tempAsst, role: 'assistant', content: null, status: 'pending', contentType: 'video', jobStatus: 'submitting' },
    ]);
    setGenerating(true);
    try {
      const res = await api(`/chats/${chat.id}/videos`, { method: 'POST', body: { prompt, idempotencyKey: key } });
      setMessages((m) => m
        .map((x) => (x.id === tempUser ? { ...x, id: res.userMessageId || x.id } : x))
        .map((x) => (x.id === tempAsst ? res.message : x)));
    } catch (err) {
      setError({ category: err.data?.category || 'model', message: err.message });
      setMessages((m) => m.filter((x) => x.id !== tempAsst)); // drop the pending placeholder
    } finally {
      setGenerating(false);
      refresh();
    }
  }

  const submit = () => (isImage ? generateImage() : isVideo ? requestVideo() : send());

  function onComposerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  const keyProblem = error && (error.category === 'key' || error.category === 'credits');
  const tokenMetered = isImage && String(imageUnit || '').toLowerCase().includes('token');
  const imgUnitPhrase = tokenMetered ? 'per token (metered)' : `per ${imgUnit(imageUnit)}`;
  // The model is fixed once a chat has a thread — a conversation/generation
  // history belongs to the model that produced it. Start a new chat to switch.
  const modelLocked = messages.length > 0;

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <h1 className="chat-heading">{chat.title || 'Untitled chat'}</h1>
        <span className="chat-modality">{chat.modality}</span>
      </div>

      {/* model + provider-routing bar — hidden while the name/type editor is
          open, so a new chat's info is set up before a model is chosen */}
      {!editing && (<>
      <div className="model-bar">
        <button
          className="model-select"
          onClick={() => setPickerOpen(true)}
          disabled={modelLocked}
          title={modelLocked
            ? 'The model is fixed once a chat has messages. Start a new chat to use a different model.'
            : 'Choose a model'}
        >
          {chat.modelId ? <span className="model-current">{chat.modelId}</span> : 'Choose a model'}
          {modelLocked && <span className="model-lock" aria-hidden="true"> 🔒</span>}
        </button>
        {(isImage || isVideo) && chat.modelId && (
          <div className="cost-note-compact" tabIndex={0} role="note" aria-label="Billing and pricing note">
            <span className="cnc-summary">
              <strong className="cnc-notice">USER NOTICE</strong>
              ⚠ Variable Billing Models · hover for details
            </span>
            <div className="cnc-full small">
              {isImage ? (
                <>Image generation is billed <strong>{imgUnitPhrase}</strong>
                  {imgRateLabel(imagePrice, imageUnit) ? <> — <strong>{imgRateLabel(imagePrice, imageUnit)}</strong> for this model</> : null}.
                  Every “Generate” is a separate charge (it doesn’t resend the chat), so costs add up quickly. Each result shows its exact cost below it.</>
              ) : (
                <>Video generation is <strong>asynchronous and can be expensive</strong>
                  {fmtVideo(videoPrice) ? <> — from <strong>{fmtVideo(videoPrice)}/second</strong> of output (higher resolutions cost more), so a few-second clip is several times that</> : null}.
                  Each “Generate” is a <strong>real charge</strong> on your OpenRouter key. You’ll confirm before it runs; jobs take a few minutes and finish on their own. Each result shows its exact cost below it.</>
              )}
              <div className="cnc-disclaimer">
                Prices are estimates and <strong>may be inaccurate</strong> — verify on{' '}
                <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">openrouter.ai</a> before relying on them.
              </div>
            </div>
          </div>
        )}
        {isText && (
          <div className="provider-controls">
            <span className="ctrl-label">Route to</span>
            <div className="seg" role="group" aria-label="Provider routing preference">
              <button className={sort === 'price' ? 'on' : ''} onClick={() => setSort('price')}>Cheapest</button>
              <button className={sort === 'speed' ? 'on' : ''} onClick={() => setSort('speed')}>Fastest</button>
            </div>
            <label className="check privacy">
              <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
              No-logging providers
            </label>
            <button className="info-btn" title="What do these do?" aria-label="Explain routing" onClick={() => setShowHelp((s) => !s)}>ⓘ</button>
          </div>
        )}
      </div>
      {showHelp && isText && (
        <p className="routing-help muted small">
          These are <strong>provider-routing</strong> preferences for models that
          several providers serve. <strong>Cheapest</strong> vs <strong>Fastest</strong> picks
          the lowest-cost vs highest-throughput provider; <strong>No-logging providers</strong> limits
          routing to providers that won't log or train on your prompts. They affect cost, speed, and
          privacy — <em>not</em> the reply itself — and do nothing for a model with only one provider.
          Each reply's cost is shown beneath it.
        </p>
      )}
      </>)}

      {editing && (
        <div className="chat-settings card">
          <div className="card-head">
            <h2>Chat settings</h2>
            <button className="close-x" title="Close" aria-label="Close" onClick={closeEditor}>✕</button>
          </div>
          <label>
            Title
            <input type="text" value={title} placeholder="Untitled chat" autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dirty && saveEditor()} />
          </label>
          <label>
            Type {modelLocked && <span className="muted small">— locked once the chat has messages</span>}
            <select value={modality} disabled={modelLocked}
              title={modelLocked ? 'The chat type is fixed once the chat has messages.' : undefined}
              onChange={(e) => setModality(e.target.value)}>
              {MODALITIES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <div className="row-btns">
            <button onClick={saveEditor} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button className="danger" onClick={removeChat}>Delete chat</button>
          </div>
          {editErr && <p className="error">{editErr}</p>}
        </div>
      )}

      {/* thread */}
      <div className="thread" ref={threadRef}>
        {msgsLoading ? (
          <p className="muted pad">Loading…</p>
        ) : messages.length === 0 && !streaming ? (
          <div className="thread-empty">
            <p className="muted">No messages yet.</p>
            <p className="muted small">
              {isImage
                ? 'Pick an image model and describe what to generate below.'
                : isVideo
                  ? 'Pick a video model and describe the video to generate below.'
                  : 'Pick a model and send a message below.'}
            </p>
          </div>
        ) : (
          <div className="msgs">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="msg-role">{m.role}</div>
                {m.attachments?.length > 0 && (
                  <div className="msg-attachments">
                    {m.attachments.map((att) => (
                      att.contentType?.startsWith('video/')
                        ? <video key={att.id || att.url} src={att.url} className="msg-video" controls preload="metadata" />
                        : <img key={att.id || att.url} src={att.url} alt={att.name || 'attachment'} className="msg-image" />
                    ))}
                  </div>
                )}
                {m.content && <div className="msg-content">{m.content}</div>}
                {m.status === 'pending' && (
                  <div className="msg-content muted">
                    {m.contentType === 'video' ? (
                      <>
                        Generating video{m.jobStatus && m.jobStatus !== 'pending' ? ` (${m.jobStatus})` : ''}…{' '}
                        <span className="caret">▋</span>
                        <div className="small">This can take several minutes. You can leave this page — it’ll finish on its own.</div>
                      </>
                    ) : (
                      <>Generating image… <span className="caret">▋</span></>
                    )}
                  </div>
                )}
                {m.status === 'failed' && (
                  <div className="msg-content error-inline">⚠ {m.error || 'Generation failed.'}</div>
                )}
                {m.role === 'assistant' && fmtCost(m.costUsd) && (
                  <div className="msg-cost muted small" title="Approximate cost billed to your OpenRouter key">
                    {fmtCost(m.costUsd)}
                  </div>
                )}
              </div>
            ))}
            {streaming && (
              <div className="msg assistant">
                <div className="msg-role">assistant</div>
                <div className="msg-content">{streamingText}<span className="caret">▋</span></div>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className={`send-error ${keyProblem ? 'act' : 'model'}`}>
          <strong>{keyProblem ? 'Your key / credits: ' : error.category === 'model' ? 'Model / provider: ' : 'Error: '}</strong>
          {error.message}
          {keyProblem && <> — <Link to="/settings">open Settings</Link> to fix your key.</>}
          {error.category === 'model' && <> — try a different model.</>}
        </div>
      )}

      {/* composer */}
      <div className="composer-wrap">
        {isText && attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((a, i) => (
              <div key={a.url} className="chip">
                <img src={a.url} alt="" className="chip-thumb" />
                <span className="chip-name">{a.name}</span>
                <button className="chip-x" aria-label="Remove attachment" onClick={() => removeAttachment(i)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="composer">
          {isText && (
            <>
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
              <button
                className="attach-btn"
                title={visionSupported ? 'Attach image(s)' : 'This model does not accept image input'}
                aria-label="Attach image"
                disabled={!visionSupported || streaming || attachments.length >= MAX_ATTACH}
                onClick={() => fileInputRef.current?.click()}
              >
                📎
              </button>
            </>
          )}
          <textarea
            rows={2}
            placeholder={
              !chat.modelId
                ? 'Choose a model first…'
                : isImage
                  ? 'Describe the image to generate…  (Enter to generate)'
                  : isVideo
                    ? 'Describe the video to generate…  (Enter to continue)'
                    : 'Type a message…  (Enter to send, Shift+Enter for newline)'
            }
            value={input}
            disabled={streaming || generating}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKey}
          />
          {isImage ? (
            <button onClick={generateImage} disabled={generating || !input.trim()}>
              {generating ? 'Generating…' : 'Generate image'}
            </button>
          ) : isVideo ? (
            <button onClick={requestVideo} disabled={generating || videoPending || !input.trim()}>
              {generating ? 'Submitting…' : videoPending ? 'Generating…' : 'Generate video'}
            </button>
          ) : (
            <button onClick={send} disabled={streaming || (!input.trim() && attachments.length === 0)}>
              {streaming ? 'Sending…' : 'Send'}
            </button>
          )}
        </div>
      </div>

      {pickerOpen && (
        <ModelPicker
          modality={chat.modality}
          currentModelId={chat.modelId}
          onSelect={pickModel}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {videoConfirm && (
        <VideoConfirm
          modelId={chat.modelId}
          perSecond={videoPrice}
          onConfirm={confirmVideo}
          onCancel={() => setVideoConfirm(null)}
        />
      )}
    </div>
  );
}
