import { Router } from 'express';
import { pool } from '../db.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateEnrollment, encryptSecret, verifyCode, qrDataUrl } from './totp.js';
import { sha256, timingSafeEqualHex, generateBackupCodes } from '../crypto/tokens.js';
import { createInvite, findUsableInvite } from './invites.js';
import {
  issueTrustedDevice,
  isTrustedDevice,
  revokeTrustedDeviceByToken,
  TRUSTED_DEVICE_COOKIE,
  cookieOptions,
} from './trustedDevice.js';
import {
  requireAdmin,
  loginLimiter,
  registerLimiter,
} from './middleware.js';

export const authRouter = Router();

// ── helpers ──────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

const regenerate = (req) => new Promise((res, rej) => req.session.regenerate((e) => (e ? rej(e) : res())));

function uaLabel(req) {
  return (req.get('user-agent') || '').slice(0, 200) || null;
}

function publicUser(row) {
  return { id: row.id, email: row.email, isAdmin: row.is_admin };
}

// ── registration (invite → account + TOTP enrollment) ─────────────────────

// Step A: validate invite, create the account + (unverified) TOTP secret,
// consume the invite, and return the QR + one-time backup codes.
authRouter.post('/register/start', registerLimiter, async (req, res) => {
  const { token, email, password } = req.body || {};
  if (!token || !email || !password) {
    return res.status(400).json({ error: 'token, email and password are required' });
  }
  const normEmail = String(email).trim().toLowerCase();
  if (!EMAIL_RE.test(normEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (String(password).length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }

  const invite = await findUsableInvite(token);
  if (!invite) {
    return res.status(400).json({ error: 'Invalid or expired invite token' });
  }

  const passwordHash = await hashPassword(String(password));
  const { secret, otpauthUrl } = generateEnrollment(normEmail);
  const backupCodes = generateBackupCodes(10);
  const hashedCodes = backupCodes.map((c) => sha256(c));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Existing account with this email?
    const existing = await client.query(
      `SELECT u.id, t.verified_at
         FROM users u LEFT JOIN totp_secrets t ON t.user_id = u.id
        WHERE u.email = $1`,
      [normEmail],
    );
    if (existing.rows.length) {
      if (existing.rows[0].verified_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already registered' });
      }
      // Abandoned enrollment — clear it and start fresh (cascade drops totp).
      await client.query('DELETE FROM users WHERE id = $1', [existing.rows[0].id]);
    }

    // Re-check the invite inside the transaction and consume it atomically.
    const consumed = await client.query(
      `UPDATE invite_tokens SET used_at = now()
        WHERE id = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING id`,
      [invite.id],
    );
    if (!consumed.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid or expired invite token' });
    }

    const inserted = await client.query(
      `INSERT INTO users (email, password_hash, is_admin)
       VALUES ($1, $2, $3) RETURNING id, email, is_admin`,
      [normEmail, passwordHash, invite.is_admin],
    );
    const user = inserted.rows[0];

    await client.query(
      `INSERT INTO totp_secrets (user_id, secret, backup_codes, verified_at)
       VALUES ($1, $2, $3::jsonb, NULL)`,
      [user.id, encryptSecret(secret), JSON.stringify(hashedCodes)],
    );

    await client.query('COMMIT');

    // Half-authenticated session: awaiting TOTP enrollment confirmation.
    await regenerate(req);
    req.session.userId = user.id;
    req.session.isAdmin = user.is_admin;
    req.session.totpVerified = false;
    req.session.enrollmentPending = true;

    const qr = await qrDataUrl(otpauthUrl);
    return res.json({
      enrollment: {
        qrDataUrl: qr,
        otpauthUrl,
        secret, // shown for manual entry into the authenticator app
        backupCodes, // shown ONCE, in plaintext, right here
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[auth] register/start failed:', err.message);
    return res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// (Re)enrollment for an account that has a password but no verified TOTP —
// used by the recovery flow (login → enrollmentIncomplete → enroll → verify)
// after an admin clears a locked-out user's TOTP. Generates a fresh secret +
// backup codes, replacing any unverified prior secret.
authRouter.post('/register/enroll', registerLimiter, async (req, res) => {
  if (!req.session?.enrollmentPending || !req.session?.userId) {
    return res.status(400).json({ error: 'No enrollment in progress' });
  }
  const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
  if (!u.rows.length) return res.status(400).json({ error: 'No enrollment in progress' });

  const { secret, otpauthUrl } = generateEnrollment(u.rows[0].email);
  const backupCodes = generateBackupCodes(10);
  const hashedCodes = backupCodes.map((c) => sha256(c));

  await pool.query(
    `INSERT INTO totp_secrets (user_id, secret, backup_codes, verified_at)
     VALUES ($1, $2, $3::jsonb, NULL)
     ON CONFLICT (user_id)
     DO UPDATE SET secret = EXCLUDED.secret, backup_codes = EXCLUDED.backup_codes, verified_at = NULL`,
    [req.session.userId, encryptSecret(secret), JSON.stringify(hashedCodes)],
  );

  const qr = await qrDataUrl(otpauthUrl);
  return res.json({ enrollment: { qrDataUrl: qr, otpauthUrl, secret, backupCodes } });
});

// Step B: confirm enrollment by entering a TOTP code from the app.
authRouter.post('/register/verify', registerLimiter, async (req, res) => {
  if (!req.session?.enrollmentPending || !req.session?.userId) {
    return res.status(400).json({ error: 'No enrollment in progress' });
  }
  const { code } = req.body || {};
  const { rows } = await pool.query(
    'SELECT secret FROM totp_secrets WHERE user_id = $1',
    [req.session.userId],
  );
  if (!rows.length || !verifyCode(code, rows[0].secret)) {
    return res.status(400).json({ error: 'Invalid authentication code' });
  }

  const userId = req.session.userId;
  const isAdmin = req.session.isAdmin;
  await pool.query('UPDATE totp_secrets SET verified_at = now() WHERE user_id = $1', [userId]);

  await regenerate(req);
  req.session.userId = userId;
  req.session.isAdmin = isAdmin;
  req.session.totpVerified = true;

  // A freshly-enrolled device is trusted.
  const { raw } = await issueTrustedDevice(userId, uaLabel(req));
  res.cookie(TRUSTED_DEVICE_COOKIE, raw, cookieOptions());

  const u = await pool.query('SELECT id, email, is_admin FROM users WHERE id = $1', [userId]);
  return res.json({ user: publicUser(u.rows[0]) });
});

// ── login (password → TOTP unless trusted device) ─────────────────────────
authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const normEmail = String(email || '').trim().toLowerCase();
  const generic = { error: 'Invalid email or password' };

  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.password_hash, u.is_admin, t.verified_at
       FROM users u LEFT JOIN totp_secrets t ON t.user_id = u.id
      WHERE u.email = $1`,
    [normEmail],
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(user.password_hash, String(password || '')))) {
    return res.status(401).json(generic);
  }

  // Incomplete TOTP enrollment — send them back to finish it.
  if (!user.verified_at) {
    await regenerate(req);
    req.session.userId = user.id;
    req.session.isAdmin = user.is_admin;
    req.session.totpVerified = false;
    req.session.enrollmentPending = true;
    return res.json({ enrollmentIncomplete: true });
  }

  // Trusted device? Skip TOTP.
  const rawTd = req.signedCookies?.[TRUSTED_DEVICE_COOKIE];
  if (await isTrustedDevice(user.id, rawTd)) {
    await regenerate(req);
    req.session.userId = user.id;
    req.session.isAdmin = user.is_admin;
    req.session.totpVerified = true;
    return res.json({ user: publicUser(user), totpRequired: false });
  }

  // Otherwise: password ok, hold in a TOTP-pending state.
  await regenerate(req);
  req.session.userId = user.id;
  req.session.isAdmin = user.is_admin;
  req.session.totpVerified = false;
  req.session.totpPending = true;
  return res.json({ totpRequired: true });
});

// Second factor: a TOTP code or a one-time backup code.
authRouter.post('/login/totp', loginLimiter, async (req, res) => {
  if (!req.session?.totpPending || !req.session?.userId) {
    return res.status(400).json({ error: 'No login in progress' });
  }
  const { code, rememberDevice } = req.body || {};
  const userId = req.session.userId;

  const { rows } = await pool.query(
    'SELECT secret, backup_codes FROM totp_secrets WHERE user_id = $1',
    [userId],
  );
  if (!rows.length) return res.status(400).json({ error: 'Invalid authentication code' });

  let ok = verifyCode(code, rows[0].secret);

  // Fall back to a one-time backup code.
  if (!ok) {
    const submitted = sha256(String(code || '').trim());
    const stored = rows[0].backup_codes || [];
    const idx = stored.findIndex((h) => timingSafeEqualHex(h, submitted));
    if (idx !== -1) {
      const remaining = stored.filter((_, i) => i !== idx);
      await pool.query(
        'UPDATE totp_secrets SET backup_codes = $1::jsonb WHERE user_id = $2',
        [JSON.stringify(remaining), userId],
      );
      ok = true;
    }
  }

  if (!ok) return res.status(400).json({ error: 'Invalid authentication code' });

  const isAdmin = req.session.isAdmin;
  await regenerate(req);
  req.session.userId = userId;
  req.session.isAdmin = isAdmin;
  req.session.totpVerified = true;

  if (rememberDevice) {
    const { raw } = await issueTrustedDevice(userId, uaLabel(req));
    res.cookie(TRUSTED_DEVICE_COOKIE, raw, cookieOptions());
  }

  const u = await pool.query('SELECT id, email, is_admin FROM users WHERE id = $1', [userId]);
  return res.json({ user: publicUser(u.rows[0]) });
});

// ── session ────────────────────────────────────────────────────────────────
authRouter.get('/me', async (req, res) => {
  if (!req.session?.userId || !req.session?.totpVerified) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { rows } = await pool.query('SELECT id, email, is_admin FROM users WHERE id = $1', [
    req.session.userId,
  ]);
  if (!rows.length) return res.status(401).json({ error: 'Not authenticated' });
  return res.json({ user: publicUser(rows[0]) });
});

authRouter.post('/logout', async (req, res) => {
  // Revoke this browser's trusted device on explicit logout, and clear cookie.
  await revokeTrustedDeviceByToken(req.signedCookies?.[TRUSTED_DEVICE_COOKIE]);
  res.clearCookie(TRUSTED_DEVICE_COOKIE, { path: '/' });
  req.session.destroy(() => {
    res.clearCookie('mmchat.sid', { path: '/' });
    res.json({ ok: true });
  });
});

// ── admin: issue invite tokens ─────────────────────────────────────────────
authRouter.post('/invites', requireAdmin, async (req, res) => {
  const { isAdmin = false, expiresInHours = 72 } = req.body || {};
  const invite = await createInvite({
    createdByUserId: req.session.userId,
    isAdmin: Boolean(isAdmin),
    expiresInHours: Math.min(Math.max(Number(expiresInHours) || 72, 1), 24 * 30),
  });
  return res.json({
    token: invite.raw,
    isAdmin: invite.is_admin,
    expiresAt: invite.expires_at,
    signupPath: `/register?token=${encodeURIComponent(invite.raw)}`,
  });
});
