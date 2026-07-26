import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

// Holds the logged-in user's chat list plus CRUD helpers, shared between the
// sidebar and the chat pane so both stay in sync without prop-drilling.
const ChatsContext = createContext(null);

export function ChatsProvider({ children }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  // Which chat's settings editor is open (null = none). The editor lives in the
  // chat pane but is toggled from the sidebar's ⋯ menu, so the flag is shared.
  const [editingChatId, setEditingChatId] = useState(null);
  const toggleEditor = useCallback((id) => {
    setEditingChatId((prev) => (prev === id ? null : id));
  }, []);
  const openEditor = useCallback((id) => setEditingChatId(id), []);
  const closeEditor = useCallback(() => setEditingChatId(null), []);

  const refresh = useCallback(async () => {
    try {
      const { chats } = await api('/chats');
      setChats(chats);
    } catch {
      setChats([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createChat = useCallback(async ({ title, modality = 'text' } = {}) => {
    const { chat } = await api('/chats', { method: 'POST', body: { title, modality } });
    setChats((prev) => [chat, ...prev]);
    return chat;
  }, []);

  const updateChat = useCallback(async (id, patch) => {
    const { chat } = await api(`/chats/${id}`, { method: 'PATCH', body: patch });
    // Re-sort by updated_at (the patch bumps it) so the touched chat floats up.
    setChats((prev) =>
      [chat, ...prev.filter((c) => c.id !== id)].sort(
        (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      ),
    );
    return chat;
  }, []);

  const deleteChat = useCallback(async (id) => {
    await api(`/chats/${id}`, { method: 'DELETE' });
    setChats((prev) => prev.filter((c) => c.id !== id));
    setEditingChatId((prev) => (prev === id ? null : prev));
  }, []);

  return (
    <ChatsContext.Provider
      value={{
        chats, loading, refresh, createChat, updateChat, deleteChat,
        editingChatId, toggleEditor, openEditor, closeEditor,
      }}
    >
      {children}
    </ChatsContext.Provider>
  );
}

export function useChats() {
  const ctx = useContext(ChatsContext);
  if (!ctx) throw new Error('useChats must be used within ChatsProvider');
  return ctx;
}
