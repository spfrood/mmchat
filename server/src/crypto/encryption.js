import crypto from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM encryption for secrets at rest (TOTP secrets now; OpenRouter key
// and cloud refresh tokens in later steps). The master key comes from
// ENCRYPTION_KEY (validated as 32 bytes / 64 hex chars at config load).
//
// Ciphertext format: base64(iv).base64(authTag).base64(ciphertext)

const KEY = Buffer.from(config.encryptionKey, 'hex');
const IV_BYTES = 12; // 96-bit nonce, standard for GCM

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [ivB64, tagB64, ctB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('Malformed ciphertext');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
