import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import EnrollTotp from '../auth/EnrollTotp.jsx';

export default function LoginPage() {
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [step, setStep] = useState('credentials'); // credentials | totp | enroll
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);
  const [enrollment, setEnrollment] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function done(user) {
    setUser(user);
    navigate('/', { replace: true });
  }

  async function submitCredentials(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api('/auth/login', { method: 'POST', body: { email, password } });
      if (res.totpRequired) {
        setStep('totp');
      } else if (res.enrollmentIncomplete) {
        // Recovery: password ok but TOTP was reset — re-enroll a fresh app.
        const { enrollment } = await api('/auth/register/enroll', { method: 'POST' });
        setEnrollment(enrollment);
        setStep('enroll');
      } else if (res.user) {
        done(res.user); // trusted device — TOTP skipped
      }
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { user } = await api('/auth/login/totp', {
        method: 'POST',
        body: { code, rememberDevice },
      });
      done(user);
    } catch (err) {
      setError(err.message || 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'enroll' && enrollment) {
    return (
      <main className="auth">
        <EnrollTotp enrollment={enrollment} onEnrolled={done} />
      </main>
    );
  }

  if (step === 'totp') {
    return (
      <main className="auth">
        <form className="card" onSubmit={submitTotp}>
          <h1>Two-factor authentication</h1>
          <p className="muted">Enter the 6-digit code from your authenticator app, or a backup code.</p>
          <label>
            Code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              autoFocus
              required
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
            Trust this device for 30 days
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</button>
        </form>
      </main>
    );
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submitCredentials}>
        <h1>Log in</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
        <p className="muted small">Have an invite? <Link to="/register">Create an account</Link></p>
      </form>
    </main>
  );
}
