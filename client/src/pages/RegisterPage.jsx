import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import EnrollTotp from '../auth/EnrollTotp.jsx';

export default function RegisterPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [token, setToken] = useState(params.get('token') || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [enrollment, setEnrollment] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { enrollment } = await api('/auth/register/start', {
        method: 'POST',
        body: { token, email, password },
      });
      setEnrollment(enrollment);
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  function finished(user) {
    setUser(user);
    navigate('/', { replace: true });
  }

  if (enrollment) {
    return (
      <main className="auth">
        <EnrollTotp enrollment={enrollment} onEnrolled={finished} />
      </main>
    );
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={start}>
        <h1>Create your account</h1>
        <p className="muted">You need a one-time invite token to sign up.</p>
        <label>
          Invite token
          <input value={token} onChange={(e) => setToken(e.target.value)} required />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password <span className="muted small">(min 8 characters)</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Continue'}</button>
        <p className="muted small">Already have an account? <Link to="/login">Log in</Link></p>
      </form>
    </main>
  );
}
