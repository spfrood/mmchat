import { useNavigate } from 'react-router-dom';
import { useChats } from '../chat/ChatsContext.jsx';

// The pane shown at "/" — no chat selected yet.
export default function ChatIndex() {
  const { createChat } = useChats();
  const navigate = useNavigate();

  async function start() {
    const chat = await createChat({ modality: 'text' });
    navigate(`/chat/${chat.id}`);
  }

  return (
    <div className="pane-empty">
      <h1>No chat selected</h1>
      <p className="muted">Pick a chat from the sidebar, or start a new one.</p>
      <button className="inline" onClick={start}>+ New chat</button>
    </div>
  );
}
