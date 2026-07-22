import { useState } from 'react';
import { api } from '../api.js';

// Renders the TOTP enrollment step: QR + manual secret + one-time backup codes,
// then a code field to confirm. Used by both first-time signup and recovery
// re-enrollment. Calls onEnrolled(user) once the code verifies.
export default function EnrollTotp({ enrollment, onEnrolled }) {
  const [code, setCode] = useState('');
  const [savedCodes, setSavedCodes] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { user } = await api('/auth/register/verify', { method: 'POST', body: { code } });
      onEnrolled(user);
    } catch (err) {
      setError(err.message || 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Set up two-factor authentication</h2>
      <p className="muted">Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password, etc.).</p>

      <img className="qr" src={enrollment.qrDataUrl} alt="TOTP QR code" width={200} height={200} />

      <details className="manual">
        <summary>Can't scan? Enter this secret manually</summary>
        <code className="secret">{enrollment.secret}</code>
      </details>

      <div className="backup">
        <h3>Backup codes</h3>
        <p className="muted">Save these somewhere safe. Each works once if you lose your authenticator. They won't be shown again.</p>
        <ul className="codes">
          {enrollment.backupCodes.map((c) => (
            <li key={c}><code>{c}</code></li>
          ))}
        </ul>
        <label className="check">
          <input type="checkbox" checked={savedCodes} onChange={(e) => setSavedCodes(e.target.checked)} />
          I've saved my backup codes
        </label>
      </div>

      <form onSubmit={submit}>
        <label>
          Enter the 6-digit code from your app
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !savedCodes || code.length < 6}>
          {busy ? 'Verifying…' : 'Confirm & finish'}
        </button>
        {!savedCodes && <p className="muted small">Confirm you've saved your backup codes to continue.</p>}
      </form>
    </div>
  );
}
