import { pool } from '../db.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../crypto/tokens.js';

// Trusted-device tokens let a specific browser skip the TOTP challenge for
// `trustedDeviceDays`. The raw token lives only in a signed httpOnly cookie;
// the server stores just its SHA-256 hash, so it can be individually revoked
// (settings) or bulk-invalidated (password change, admin reset).

export const TRUSTED_DEVICE_COOKIE = 'td';

// Persist a new trusted device and return the raw token to put in the cookie.
export async function issueTrustedDevice(userId, userAgentLabel) {
  const raw = randomToken(32);
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + config.trustedDeviceDays * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO trusted_devices (user_id, token_hash, expires_at, last_used_at, user_agent_label)
     VALUES ($1, $2, $3, now(), $4)`,
    [userId, tokenHash, expiresAt, userAgentLabel || null],
  );
  return { raw, expiresAt };
}

// Return true if the raw cookie token maps to a live trusted device for this
// user; refreshes last_used_at as a side effect.
export async function isTrustedDevice(userId, rawToken) {
  if (!rawToken) return false;
  const tokenHash = sha256(rawToken);
  const { rows } = await pool.query(
    `UPDATE trusted_devices
        SET last_used_at = now()
      WHERE user_id = $1 AND token_hash = $2 AND expires_at > now()
      RETURNING id`,
    [userId, tokenHash],
  );
  return rows.length > 0;
}

// Revoke a single device by its raw cookie token (e.g. on logout-this-device).
export async function revokeTrustedDeviceByToken(rawToken) {
  if (!rawToken) return;
  await pool.query('DELETE FROM trusted_devices WHERE token_hash = $1', [sha256(rawToken)]);
}

// Revoke every trusted device for a user (password change / admin reset).
export async function revokeAllTrustedDevices(userId) {
  await pool.query('DELETE FROM trusted_devices WHERE user_id = $1', [userId]);
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    signed: true,
    maxAge: config.trustedDeviceDays * 24 * 60 * 60 * 1000,
    path: '/',
  };
}
