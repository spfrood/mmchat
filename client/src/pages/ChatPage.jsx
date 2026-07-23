import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useChats } from '../chat/ChatsContext.jsx';

const MODALITIES = ['text', 'image', 'video'];

// A single chat pane. Step 2 has no real message flow yet, so this shows an
// empty thread plus — only when opened from the sidebar's ⋯ menu — a settings
// editor (title / modality; the model picker lands in Step 3). Rename and delete
// happen in that editor, which closes on Save or ✕.
export default function ChatPage() {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const { chats, loading, updateChat, deleteChat, editingChatId, closeEditor } = useChats();

  const chat = chats.find((c) => c.id === chatId);
  const editing = chat && editingChatId === chat.id;

  const [title, setTitle] = useState('');
  const [modality, setModality] = useState('text');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Re-seed the editor fields whenever it opens for a (different) chat.
  useEffect(() => {
    if (chat) {
      setTitle(chat.title || '');
      setModality(chat.modality);
      setError('');
    }
  }, [chat?.id, editing]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function save() {
    setError('');
    setSaving(true);
    try {
      await updateChat(chat.id, { title, modality });
      closeEditor(); // editor disappears on save
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this chat? This cannot be undone.')) return;
    try {
      await deleteChat(chat.id);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Failed to delete');
    }
  }

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <h1 className="chat-heading">{chat.title || 'Untitled chat'}</h1>
        <span className="chat-modality">{chat.modality}</span>
      </div>

      {editing && (
        <div className="chat-settings card">
          <div className="card-head">
            <h2>Chat settings</h2>
            <button className="close-x" title="Close" aria-label="Close" onClick={closeEditor}>✕</button>
          </div>

          <label>
            Title
            <input
              type="text"
              value={title}
              placeholder="Untitled chat"
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
            />
          </label>

          <label>
            Modality
            <select value={modality} onChange={(e) => setModality(e.target.value)}>
              {MODALITIES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>

          <p className="muted small">
            Model: {chat.modelId || <em>not set</em>} — the model picker arrives in Step 3.
          </p>

          <div className="row-btns">
            <button onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button className="danger" onClick={remove}>Delete chat</button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      <div className="thread">
        <div className="thread-empty">
          <p className="muted">No messages yet.</p>
          <p className="muted small">Sending messages to a model comes in a later step.</p>
        </div>
      </div>
    </div>
  );
}
