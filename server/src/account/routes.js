import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { revokeAllTrustedDevices, TRUSTED_DEVICE_COOKIE } from '../auth/trustedDevice.js';
import { getSpend, deleteAccount } from './service.js';

// /api/account — the Settings/account menu (Step 11): profile (email/password)
// editing, the spend dashboard, and irreversible account deletion. Credits are
// read via /api/keys/credits (already built); those are surfaced in the same UI.
export const accountRouter = Router();

accountRouter.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Current profile basics. Email + password are the only user-editable fields the
// schema carries (there's no display-name column), so "profile" is those two.
accountRouter.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, is_admin, created_at FROM users WHERE id = $1',
      [req.session.userId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Account not found' });
    res.json({ email: rows[0].email, isAdmin: rows[0].is_admin, createdAt: rows[0].created_at });
  } catch (err) {
    console.error('[account] get failed:', err.message);
    res.status(500).json({ error: 'Failed to load account' });
  }
});

// PATCH /api/account/profile — change email and/or password. The current
// password is required for either change (it's a sensitive operation). A
// password change revokes every trusted device (bible) and clears this browser's
// trusted-device cookie so TOTP is re-required on next login.
accountRouter.patch('/profile', async (req, res) => {
  const userId = req.session.userId;
  const { currentPassword, email, newPassword } = req.body || {};

  const { rows } = await pool.query('SELECT password_hash, email FROM users WHERE id = $1', [userId]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });

  if (!currentPassword || !(await verifyPassword(rows[0].password_hash, String(currentPassword)))) {
    return res.status(403).json({ error: 'Current password is incorrect.' });
  }

  const normEmail = email === undefined ? null : String(email).trim().toLowerCase();
  const wantsEmail = normEmail !== null && normEmail !== rows[0].email;
  const wantsPassword = newPassword !== undefined && String(newPassword) !== '';
  if (!wantsEmail && !wantsPassword) {
    return res.status(400).json({ error: 'Nothing to change — enter a new email or password.' });
  }

  const sets = [];
  const vals = [];
  let i = 1;

  if (wantsEmail) {
    if (!EMAIL_RE.test(normEmail)) return res.status(400).json({ error: 'Invalid email address.' });
    sets.push(`email = $${i++}`);
    vals.push(normEmail);
  }
  if (wantsPassword) {
    if (String(newPassword).length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    }
    sets.push(`password_hash = $${i++}`);
    vals.push(await hashPassword(String(newPassword)));
  }
  vals.push(userId);

  let updated;
  try {
    const r = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING email, is_admin`,
      vals,
    );
    updated = r.rows[0];
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email is already in use.' });
    console.error('[account] profile update failed:', err.message);
    return res.status(500).json({ error: 'Failed to update profile' });
  }

  if (wantsPassword) {
    await revokeAllTrustedDevices(userId);
    res.clearCookie(TRUSTED_DEVICE_COOKIE, { path: '/' });
  }

  res.json({
    email: updated.email,
    isAdmin: updated.is_admin,
    emailChanged: wantsEmail,
    passwordChanged: wantsPassword,
  });
});

// GET /api/account/spend — total (all-time + this month) and by-model/by-chat
// breakdowns over the stored messages.cost_usd.
accountRouter.get('/spend', async (req, res) => {
  try {
    res.json(await getSpend(req.session.userId));
  } catch (err) {
    console.error('[account] spend failed:', err.message);
    res.status(500).json({ error: 'Failed to load spend' });
  }
});

// DELETE /api/account — irreversible. Requires the current password as the
// explicit confirmation gate (the client also requires a typed confirmation).
// Removes all local + DB records; cloud-folder files are left untouched.
accountRouter.delete('/', async (req, res) => {
  const userId = req.session.userId;
  const { currentPassword } = req.body || {};

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });
  if (!currentPassword || !(await verifyPassword(rows[0].password_hash, String(currentPassword)))) {
    return res.status(403).json({ error: 'Current password is incorrect.' });
  }

  try {
    await deleteAccount(userId);
  } catch (err) {
    console.error('[account] delete failed:', err.message);
    return res.status(500).json({ error: 'Failed to delete account.' });
  }

  // Tear down the current session + cookies (the session row is already gone).
  res.clearCookie(TRUSTED_DEVICE_COOKIE, { path: '/' });
  req.session.destroy(() => {
    res.clearCookie('mmchat.sid', { path: '/' });
    res.json({ ok: true });
  });
});
