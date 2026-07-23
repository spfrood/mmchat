import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useChats } from '../chat/ChatsContext.jsx';
import { streamMessage } from '../chat/stream.js';
import ModelPicker from '../chat/ModelPicker.jsx';

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

export default function ChatPage() {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const { chats, loading, updateChat, deleteChat, refresh, editingChatId, closeEditor } = useChats();

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

  // Does the current model accept image input? Gates the attach control.
  useEffect(() => {
    if (!chat?.modelId) { setVisionSupported(false); return; }
    let alive = true;
    api(`/models/capabilities?id=${encodeURIComponent(chat.modelId)}`)
      .then((r) => { if (alive) setVisionSupported(!!r.supportsImageInput); })
      .catch(() => { if (alive) setVisionSupported(false); });
    return () => { alive = false; };
  }, [chat?.modelId]);

  // Clear staged attachments when switching chats.
  useEffect(() => { setAttachments([]); }, [chatId]);

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
    }
  }

  function onComposerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const keyProblem = error && (error.category === 'key' || error.category === 'credits');

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <h1 className="chat-heading">{chat.title || 'Untitled chat'}</h1>
        <span className="chat-modality">{chat.modality}</span>
      </div>

      {/* model + provider-routing bar */}
      <div className="model-bar">
        <button className="model-select" onClick={() => setPickerOpen(true)}>
          {chat.modelId ? <span className="model-current">{chat.modelId}</span> : 'Choose a model'}
        </button>
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
      </div>
      {showHelp && (
        <p className="routing-help muted small">
          These are <strong>provider-routing</strong> preferences for models that
          several providers serve. <strong>Cheapest</strong> vs <strong>Fastest</strong> picks
          the lowest-cost vs highest-throughput provider; <strong>No-logging providers</strong> limits
          routing to providers that won't log or train on your prompts. They affect cost, speed, and
          privacy — <em>not</em> the reply itself — and do nothing for a model with only one provider.
          Each reply's cost is shown beneath it.
        </p>
      )}

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
            Modality
            <select value={modality} onChange={(e) => setModality(e.target.value)}>
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
              {chat.modality === 'text'
                ? 'Pick a model and send a message below.'
                : 'Text chat is available now; image/video come in later steps.'}
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
                      <img
                        key={att.id || att.url}
                        src={att.url}
                        alt={att.name || 'attachment'}
                        className="msg-image"
                      />
                    ))}
                  </div>
                )}
                {m.content && <div className="msg-content">{m.content}</div>}
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
        {attachments.length > 0 && (
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
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onPickFiles}
          />
          <button
            className="attach-btn"
            title={visionSupported ? 'Attach image(s)' : 'This model does not accept image input'}
            aria-label="Attach image"
            disabled={!visionSupported || streaming || attachments.length >= MAX_ATTACH}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
          <textarea
            rows={2}
            placeholder={chat.modelId ? 'Type a message…  (Enter to send, Shift+Enter for newline)' : 'Choose a model first…'}
            value={input}
            disabled={streaming}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKey}
          />
          <button onClick={send} disabled={streaming || (!input.trim() && attachments.length === 0)}>
            {streaming ? 'Sending…' : 'Send'}
          </button>
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
    </div>
  );
}
