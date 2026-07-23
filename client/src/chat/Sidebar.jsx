import { NavLink, useNavigate } from 'react-router-dom';
import { useChats } from './ChatsContext.jsx';

// Flat list of the user's chats + a "new chat" button. The collapse/expand
// toggle is owned by ChatLayout and passed in.
export default function Sidebar({ collapsed, onToggle }) {
  const { chats, loading, createChat, toggleEditor } = useChats();
  const navigate = useNavigate();

  async function handleNewChat() {
    try {
      const chat = await createChat({ modality: 'text' });
      navigate(`/chat/${chat.id}`);
    } catch {
      // createChat surfaces errors in the pane; keep the sidebar quiet.
    }
  }

  // ⋯ menu: open (toggle) that chat's settings editor, ensuring we're on it.
  function handleMenu(e, id) {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/chat/${id}`);
    toggleEditor(id);
  }

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="icon-btn" title="Expand sidebar" onClick={onToggle}>»</button>
        <button className="icon-btn" title="New chat" onClick={handleNewChat}>+</button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="new-chat" onClick={handleNewChat}>+ New chat</button>
        <button className="icon-btn" title="Collapse sidebar" onClick={onToggle}>«</button>
      </div>

      <nav className="chat-list">
        {loading && <p className="muted small pad">Loading…</p>}
        {!loading && chats.length === 0 && (
          <p className="muted small pad">No chats yet. Start one above.</p>
        )}
        {chats.map((c) => (
          <div key={c.id} className="chat-row">
            <NavLink
              to={`/chat/${c.id}`}
              className={({ isActive }) => `chat-item${isActive ? ' active' : ''}`}
            >
              <span className="chat-title">{c.title || 'Untitled chat'}</span>
              <span className="chat-modality">{c.modality}</span>
            </NavLink>
            <button
              className="kebab"
              title="Chat options"
              aria-label="Chat options"
              onClick={(e) => handleMenu(e, c.id)}
            >
              ⋯
            </button>
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <NavLink to="/settings" className="foot-link">⚙ Settings</NavLink>
      </div>
    </aside>
  );
}
