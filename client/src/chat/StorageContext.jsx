import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

// Shared local-storage usage, so the persistent 3.5 GB notice and the settings
// display read one source. Fetched on load (not just after the write that
// crossed the threshold) and on window focus (catches changes from other tabs),
// plus an explicit refresh() the chat pane calls after a generation or delete.
const StorageContext = createContext(null);

export function StorageProvider({ children }) {
  const [status, setStatus] = useState(null); // { usedBytes, capBytes, noticeBytes, atNotice, atCap }

  const refresh = useCallback(async () => {
    try {
      setStatus(await api('/storage'));
    } catch {
      /* leave the last-known status in place on a transient failure */
    }
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return (
    <StorageContext.Provider value={{ status, refresh }}>
      {children}
    </StorageContext.Provider>
  );
}

export function useStorage() {
  const ctx = useContext(StorageContext);
  if (!ctx) throw new Error('useStorage must be used within StorageProvider');
  return ctx;
}

// GB formatting shared by the banner and settings display.
export function fmtGb(bytes) {
  return `${(Number(bytes || 0) / 1024 ** 3).toFixed(1)} GB`;
}
