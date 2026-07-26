import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useStorage, fmtGb } from '../chat/StorageContext.jsx';

// A collapsible settings section: title bar with a ✕ to close it, and a click
// anywhere on the bar to toggle it back open.
function Section({ title, children }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="card">
      <div className="card-head clickable" onClick={() => setOpen((o) => !o)}>
        <h2>{title}</h2>
        <button
          className="close-x"
          title={open ? 'Close' : 'Open'}
          aria-label={open ? 'Close section' : 'Open section'}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        >
          {open ? '✕' : '▾'}
        </button>
      </div>
      {open && <div className="card-body">{children}</div>}
    </section>
  );
}

// Settings: the user's OpenRouter API key (BYOK) and, for admins, invite-token
// generation. The full key is never returned by the server after saving — the
// UI only ever shows the last 4 characters.
export default function SettingsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [meta, setMeta] = useState(null); // { hasKey, suffix?, label?, createdAt? }
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  async function loadMeta() {
    try {
      setMeta(await api('/keys'));
    } catch {
      setMeta({ hasKey: false });
    }
  }

  useEffect(() => { loadMeta(); }, []);

  async function saveKey() {
    setError('');
    setNote('');
    setBusy(true);
    try {
      const res = await api('/keys', { method: 'PUT', body: { key: keyInput } });
      setMeta(res);
      setKeyInput('');
      setNote('API key saved. Only the last 4 characters are shown from now on.');
    } catch (err) {
      setError(err.message || 'Failed to save key');
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    if (!window.confirm('Remove your saved OpenRouter API key?')) return;
    setError('');
    setNote('');
    setBusy(true);
    try {
      setMeta(await api('/keys', { method: 'DELETE' }));
      setNote('API key removed.');
    } catch (err) {
      setError(err.message || 'Failed to remove key');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <div className="settings-head">
        <h1>Settings</h1>
        <button className="link-btn" onClick={() => navigate('/')}>✕ Close</button>
      </div>

      <Section title="OpenRouter API key">
        <p className="muted small">
          Your key is encrypted at rest and used only to make requests on your
          behalf. It's never shown again after you save it.
        </p>

        {meta?.hasKey ? (
          <p className="key-status">
            Key on file: <code className="secret inline">••••••••••••{meta.suffix}</code>
            {meta.label ? <span className="muted small"> · {meta.label}</span> : null}
          </p>
        ) : (
          <p className="muted small">No key saved yet.</p>
        )}

        <label>
          {meta?.hasKey ? 'Replace key' : 'Paste your key'}
          <input
            type="password"
            value={keyInput}
            placeholder="sk-or-v1-…"
            autoComplete="off"
            onChange={(e) => setKeyInput(e.target.value)}
          />
        </label>

        <div className="row-btns">
          <button onClick={saveKey} disabled={busy || !keyInput.trim()}>
            {busy ? 'Saving…' : meta?.hasKey ? 'Replace key' : 'Save key'}
          </button>
          {meta?.hasKey && (
            <button className="danger" onClick={removeKey} disabled={busy}>Remove key</button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {note && <p className="muted small">{note}</p>}
      </Section>

      <Section title="Local storage">
        <StorageUsage />
      </Section>

      {user.isAdmin && (
        <Section title="Admin — generate an invite">
          <AdminInvites />
        </Section>
      )}
    </div>
  );
}

// Local storage used vs. the 5 GB cap. Reads the shared storage status (and
// refreshes it on open so the figure is current). Generated media and uploaded
// input both count; text messages don't.
function StorageUsage() {
  const { status, refresh } = useStorage();

  useEffect(() => { refresh(); }, [refresh]);

  if (!status) return <p className="muted small">Loading…</p>;

  const pct = status.capBytes ? Math.min(100, (status.usedBytes / status.capBytes) * 100) : 0;
  const fillClass = status.atCap ? 'full' : status.atNotice ? 'warn' : '';

  return (
    <>
      <p className="key-status">
        {fmtGb(status.usedBytes)} of {fmtGb(status.capBytes)} used
        <span className="muted small"> · {pct.toFixed(0)}%</span>
      </p>
      <div className="storage-meter">
        <div className="storage-bar">
          <div className={`storage-bar-fill ${fillClass}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      {status.atCap ? (
        <p className="error">
          You've reached the {fmtGb(status.capBytes)} limit. New uploads and image/video
          generations are blocked until you delete some media. Text and existing chats still work.
        </p>
      ) : status.atNotice ? (
        <p className="muted small">
          You're past {fmtGb(status.noticeBytes)} — approaching the {fmtGb(status.capBytes)} limit.
        </p>
      ) : (
        <p className="muted small">
          Generated media and uploaded images count toward this limit; text messages don't.
          Deleting a chat frees the media it held.
        </p>
      )}
    </>
  );
}

function AdminInvites() {
  const [invite, setInvite] = useState(null);
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function generateInvite() {
    setError('');
    setBusy(true);
    try {
      setInvite(await api('/auth/invites', { method: 'POST', body: { isAdmin: makeAdmin } }));
    } catch (err) {
      setError(err.message || 'Failed to create invite');
    } finally {
      setBusy(false);
    }
  }

  const signupUrl = invite ? `${window.location.origin}${invite.signupPath}` : '';

  return (
    <>
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
          <div className="card-head">
            <p className="muted small">New invite</p>
            <button className="close-x" title="Dismiss" aria-label="Dismiss" onClick={() => setInvite(null)}>✕</button>
          </div>
          <p>Token (share out-of-band, one-time use):</p>
          <code className="secret">{invite.token}</code>
          <p className="muted small">Sign-up link:</p>
          <code className="secret">{signupUrl}</code>
          <p className="muted small">
            Expires {new Date(invite.expiresAt).toLocaleString()} · admin: {String(invite.isAdmin)}
          </p>
        </div>
      )}
    </>
  );
}
