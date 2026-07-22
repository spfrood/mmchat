import crypto from 'node:crypto';

// Helpers for opaque, high-entropy tokens (invite tokens, trusted-device
// tokens, backup codes). These are hashed with SHA-256 for storage — unlike
// passwords, they're random and high-entropy, so a fast hash is appropriate
// and lets us do constant-time equality on the digest.

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

// Constant-time comparison of two hex digests of equal length.
export function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// One-time backup codes, formatted xxxxx-xxxxx (10 hex chars, ~40 bits each).
export function generateBackupCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
