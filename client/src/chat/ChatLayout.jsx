import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { ChatsProvider } from './ChatsContext.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import Sidebar from './Sidebar.jsx';

// The authenticated app shell: persistent sidebar + a top bar, with the routed
// pane (chat / settings / index placeholder) rendered into the <Outlet/>.
export default function ChatLayout() {
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <ChatsProvider>
      <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
        <div className="main-col">
          <header className="topbar">
            <strong>mmchat</strong>
            <div className="topbar-right">
              <span className="muted small">
                {user.email}{user.isAdmin ? ' · admin' : ''}
              </span>
              <button className="link-btn" onClick={logout}>Log out</button>
            </div>
          </header>
          <main className="pane">
            <Outlet />
          </main>
        </div>
      </div>
    </ChatsProvider>
  );
}
