import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

export default function HomePage() {
  const { user, logout } = useAuth();
  const [invite, setInvite] = useState(null);
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function generateInvite() {
    setError('');
    setBusy(true);
    try {
      const res = await api('/auth/invites', { method: 'POST', body: { isAdmin: makeAdmin } });
      setInvite(res);
    } catch (err) {
      setError(err.message || 'Failed to create invite');
    } finally {
      setBusy(false);
    }
  }

  const signupUrl = invite ? `${window.location.origin}${invite.signupPath}` : '';

  return (
    <main className="home">
      <header className="topbar">
        <div>
          <strong>mmchat</strong>
          <span className="muted"> — logged in as {user.email}{user.isAdmin ? ' (admin)' : ''}</span>
        </div>
        <button onClick={logout}>Log out</button>
      </header>

      <section className="placeholder">
        <h1>You're logged in.</h1>
        <p className="muted">Nothing here yet — chat comes in Step 2.</p>
      </section>

      {user.isAdmin && (
        <section className="card admin">
          <h2>Admin — generate an invite</h2>
          <label className="check">
            <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
            Grant admin to the new account
          </label>
          <button onClick={generateInvite} disabled={busy}>
            {busy ? 'Generating…' : 'Create invite token'}
          </button>
          {error && <p className="error">{error}</p>}
          {invite && (
            <div className="invite-out">
              <p>Token (share out-of-band, one-time use):</p>
              <code className="secret">{invite.token}</code>
              <p className="muted small">Sign-up link:</p>
              <code className="secret">{signupUrl}</code>
              <p className="muted small">
                Expires {new Date(invite.expiresAt).toLocaleString()} · admin: {String(invite.isAdmin)}
              </p>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
