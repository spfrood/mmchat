import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { encrypt, decrypt } from '../crypto/encryption.js';

// TOTP second factor. Secrets are stored encrypted (AES-256-GCM) because,
// unlike a password, the server must recover the plaintext secret to verify
// codes — so it can't be one-way hashed.

const SERVICE = 'mmchat';

// Allow ±1 time step (±30s) of clock drift when verifying.
authenticator.options = { window: 1 };

// Create a fresh secret + the otpauth:// URL used to build the enrollment QR.
export function generateEnrollment(email) {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(email, SERVICE, secret);
  return { secret, otpauthUrl };
}

export const encryptSecret = (secret) => encrypt(secret);

// Verify a 6-digit code against an encrypted secret.
export function verifyCode(code, encryptedSecret) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return false;
  const secret = decrypt(encryptedSecret);
  return authenticator.check(String(code).trim(), secret);
}

export function qrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}
