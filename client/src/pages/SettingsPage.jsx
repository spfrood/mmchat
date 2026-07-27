import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useStorage, fmtGb } from '../chat/StorageContext.jsx';

// Contact address for the "Contact me" button. Sourced from an env var (not
// hardcoded) so the deployment domain stays out of the committed repo; the
// section only renders when it's set. See client/.env.example.
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || '';

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
  const { user, refresh, setUser } = useAuth();
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

      <Section title="Profile">
        <ProfileSection user={user} onEmailChange={refresh} />
      </Section>

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

        <Credits hasKey={meta?.hasKey} />
      </Section>

      <Section title="Spend">
        <SpendDashboard />
      </Section>

      <Section title="Local storage">
        <StorageUsage />
      </Section>

      <Section title="Cloud storage">
        <CloudStorage />
      </Section>

      {user.isAdmin && (
        <Section title="Admin — generate an invite">
          <AdminInvites />
        </Section>
      )}

      <Section title="Delete account">
        <DeleteAccount
          onDeleted={() => {
            setUser(null);
            navigate('/login', { replace: true });
          }}
        />
      </Section>

      {CONTACT_EMAIL && (
        <Section title="Contact">
          <p className="muted small">
            Questions, a problem to report, or need help with your account? Click to email{' '}
            <code className="secret inline">{CONTACT_EMAIL}</code>.
          </p>
          <div className="row-btns">
            <button onClick={() => { window.location.href = `mailto:${CONTACT_EMAIL}`; }}>
              Contact me
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}

// Currency: costs are often fractions of a cent, so show enough precision to be
// meaningful without a wall of zeros. Under a cent → 4 dp; otherwise 2 dp.
function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

// Profile: shows the current email read-only, with an Edit button that opens a
// modal to change email OR password. Nothing sensitive sits inline on the page.
function ProfileSection({ user, onEmailChange }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');

  return (
    <>
      <p className="key-status">
        Signed in as <code className="secret inline">{user.email}</code>
        {user.isAdmin ? <span className="muted small"> · admin</span> : null}
      </p>
      <div className="row-btns">
        <button onClick={() => { setNote(''); setEditing(true); }}>Edit</button>
      </div>
      {note && <p className="muted small">{note}</p>}
      {editing && (
        <ProfileEditModal
          user={user}
          onClose={() => setEditing(false)}
          onSaved={(msg, emailChanged) => {
            setNote(msg);
            setEditing(false);
            if (emailChanged) onEmailChange();
          }}
        />
      )}
    </>
  );
}

// Edit-profile dialog. Two modes — change email or change password — behind a
// toggle. The current password gates either change (it's sensitive). A password
// change also requires re-typing the new one (catches typos) and, server-side,
// revokes trusted devices so TOTP is re-required on next login everywhere.
function ProfileEditModal({ user, onClose, onSaved }) {
  const [mode, setMode] = useState('email'); // 'email' | 'password'
  const [email, setEmail] = useState(user.email);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const emailChanged = email.trim().toLowerCase() !== user.email;

  function switchMode(m) {
    setMode(m);
    setError('');
  }

  async function submit() {
    setError('');
    if (mode === 'email') {
      if (!emailChanged) return setError('Enter a different email address.');
    } else {
      if (!newPassword) return setError('Enter a new password.');
      if (newPassword.length < 8) return setError('Password must be at least 8 characters.');
      if (newPassword !== confirmPassword) return setError('The new passwords don’t match.');
    }
    if (!currentPassword) return setError('Enter your current password to confirm.');

    setBusy(true);
    try {
      const body = mode === 'email'
        ? { currentPassword, email: email.trim() }
        : { currentPassword, newPassword };
      const res = await api('/account/profile', { method: 'PATCH', body });
      const msg = res.emailChanged
        ? 'Email updated.'
        : res.passwordChanged
          ? 'Password changed — other devices will need TOTP again on next login.'
          : 'Saved.';
      onSaved(msg, Boolean(res.emailChanged));
    } catch (err) {
      setError(err.message || 'Failed to update profile');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Edit profile</h2>
          <button className="close-x" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="confirm-body">
          <div className="seg" role="tablist">
            <button className={mode === 'email' ? 'on' : ''} onClick={() => switchMode('email')}>
              Change email
            </button>
            <button className={mode === 'password' ? 'on' : ''} onClick={() => switchMode('password')}>
              Change password
            </button>
          </div>

          {mode === 'email' ? (
            <label>
              New email
              <input
                type="email"
                value={email}
                autoComplete="username"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          ) : (
            <>
              <label>
                New password
                <input
                  type="password"
                  value={newPassword}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>
              <label>
                Confirm new password
                <input
                  type="password"
                  value={confirmPassword}
                  placeholder="Re-enter the new password"
                  autoComplete="new-password"
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </label>
            </>
          )}

          <label>
            Current password <span className="muted small">(required)</span>
            <input
              type="password"
              value={currentPassword}
              placeholder="Your current password"
              autoComplete="current-password"
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="row-btns">
          <button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// Live credit/limit info for the user's OpenRouter key (GET /api/keys/credits →
// OpenRouter GET /auth/key). On demand so we don't hit OpenRouter on every
// settings load.
function Credits({ hasKey }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    setBusy(true);
    try {
      setInfo(await api('/keys/credits'));
    } catch (err) {
      setError(err.message || 'Could not read credits');
    } finally {
      setBusy(false);
    }
  }

  if (!hasKey) return null;

  return (
    <div className="credits">
      <div className="row-btns">
        <button onClick={load} disabled={busy}>{busy ? 'Checking…' : 'View credits'}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {info && (
        <ul className="credits-list">
          <li>
            <span className="muted small">Used</span>
            <strong>{fmtUsd(info.usage)}</strong>
          </li>
          <li>
            <span className="muted small">Limit</span>
            <strong>{info.limit == null ? 'unlimited' : fmtUsd(info.limit)}</strong>
          </li>
          <li>
            <span className="muted small">Remaining</span>
            <strong>{info.remaining == null ? '—' : fmtUsd(info.remaining)}</strong>
          </li>
          {info.isFreeTier && <li><span className="badge">free tier</span></li>}
        </ul>
      )}
    </div>
  );
}

// Spend dashboard: total (all-time + this month) plus by-model and by-chat
// breakdowns over the stored messages.cost_usd. Self-computed estimate — the
// same figure the chat UI shows per message, aggregated.
function SpendDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/account/spend').then(setData).catch((err) => setError(err.message || 'Failed to load spend'));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted small">Loading…</p>;

  if (!data.count) {
    return <p className="muted small">No spend recorded yet. Costs appear here as you send messages and generate media.</p>;
  }

  return (
    <>
      <div className="spend-totals">
        <div className="spend-total">
          <span className="muted small">All-time</span>
          <strong>{fmtUsd(data.allTime)}</strong>
        </div>
        <div className="spend-total">
          <span className="muted small">This month</span>
          <strong>{fmtUsd(data.thisMonth)}</strong>
        </div>
      </div>
      <p className="muted small">
        Only counts messages in chats you still have — spend from deleted chats isn’t
        included, so this can read well below your real OpenRouter total. Self-computed from
        each response’s reported usage (a close estimate, not your exact bill); verify on
        openrouter.ai.
      </p>

      <h3>By model</h3>
      <SpendTable
        rows={data.byModel}
        label={(r) => r.model}
        keyOf={(r) => r.model}
      />

      <h3>By chat</h3>
      <SpendTable
        rows={data.byChat}
        label={(r) => `${r.title} · ${r.modality}`}
        keyOf={(r) => r.id}
      />
    </>
  );
}

function SpendTable({ rows, label, keyOf }) {
  return (
    <table className="spend-table">
      <tbody>
        {rows.map((r) => (
          <tr key={keyOf(r)}>
            <td className="spend-name" title={label(r)}>{label(r)}</td>
            <td className="spend-count muted small">{r.count}×</td>
            <td className="spend-amt">{fmtUsd(r.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Delete account — irreversible. Two gates: type DELETE, and re-enter the
// password (the server verifies it). Local media + all DB records go; files
// already in the user's own cloud folder are left untouched.
function DeleteAccount({ onDeleted }) {
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ready = confirmText.trim().toUpperCase() === 'DELETE' && password;

  async function remove() {
    if (!ready) return;
    setError('');
    setBusy(true);
    try {
      await api('/account', { method: 'DELETE', body: { currentPassword: password } });
      onDeleted();
    } catch (err) {
      setError(err.message || 'Failed to delete account');
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted small">
        Permanently deletes your account, chats, messages, uploaded and generated media on
        this server, your API key, and cloud-storage links. This can’t be undone. Files already
        uploaded to your own Google Drive folder are left untouched — remove those in Drive yourself.
      </p>
      <label>
        Type <code>DELETE</code> to confirm
        <input
          type="text"
          value={confirmText}
          placeholder="DELETE"
          autoComplete="off"
          onChange={(e) => setConfirmText(e.target.value)}
        />
      </label>
      <label>
        Your password
        <input
          type="password"
          value={password}
          placeholder="Your current password"
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <div className="row-btns">
        <button className="danger-solid" onClick={remove} disabled={busy || !ready}>
          {busy ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
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

// Cloud storage linking (Step 8: Google Drive). When connected, generated media
// uploads to the user's own Drive folder instead of local disk and doesn't count
// against the 5 GB cap. "Verify cloud files" reconciles our references against
// Drive after the user deletes files there directly.
function CloudStorage() {
  const [status, setStatus] = useState(null); // { google_drive: {...} }
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try { setStatus(await api('/storage/providers')); }
    catch { setStatus({ google_drive: { configured: false, connected: false } }); }
  }

  useEffect(() => {
    load();
    // Surface the outcome of the OAuth round-trip (?cloud=…&connected / &error).
    const q = new URLSearchParams(window.location.search);
    if (q.get('cloud') === 'google_drive') {
      if (q.get('connected')) setNote('Google Drive connected. New media will upload there.');
      else if (q.get('error')) setError(`Couldn't connect Google Drive (${q.get('error')}).`);
      window.history.replaceState({}, '', '/settings');
    }
  }, []);

  const gd = status?.google_drive;

  async function disconnect() {
    if (!window.confirm('Disconnect Google Drive? Files already in your Drive stay there, but they’ll no longer display in the app, and new media will save locally.')) return;
    setBusy(true); setError(''); setNote('');
    try { await api('/storage/google', { method: 'DELETE' }); setNote('Google Drive disconnected.'); await load(); }
    catch (err) { setError(err.message || 'Failed to disconnect'); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setError(''); setNote('');
    try {
      const r = await api('/storage/verify', { method: 'POST', body: {} });
      setNote(`Checked ${r.checked} file(s); flagged ${r.flagged} no longer in your Drive.`);
    } catch (err) { setError(err.message || 'Verify failed'); }
    finally { setBusy(false); }
  }

  if (!status) return <p className="muted small">Loading…</p>;

  return (
    <>
      <p className="key-status">
        <strong>Google Drive</strong>
        {gd?.connected ? <span className="muted small"> · connected</span> : null}
      </p>

      {!gd?.configured ? (
        <p className="muted small">Google Drive isn’t configured on this server.</p>
      ) : gd.connected ? (
        <>
          <p className="muted small">
            New generated media uploads to your <code>{gd.folderName}</code> folder in Google Drive
            and doesn’t count against your 5 GB local cap.
          </p>
          <div className="row-btns">
            <button onClick={verify} disabled={busy}>{busy ? 'Working…' : 'Verify cloud files'}</button>
            <button className="danger" onClick={disconnect} disabled={busy}>Disconnect</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            Connect Google Drive to store generated images and videos in your own Drive
            instead of local disk.
          </p>
          <button onClick={() => { window.location.href = '/api/storage/google/connect'; }}>
            Connect Google Drive
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {note && <p className="muted small">{note}</p>}
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
