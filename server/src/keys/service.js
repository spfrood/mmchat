import { pool } from '../db.js';
import { encrypt, decrypt } from '../crypto/encryption.js';

// BYOK OpenRouter key storage. One key per user for now (the schema allows
// several rows via api_keys.label, but v1 keeps a single active key). The raw
// key is encrypted at rest with AES-256-GCM (server-side master key); only the
// last 4 chars (key_suffix) are ever returned to the client. Decryption happens
// server-side only, at request time (later steps) — never logged, never sent out.

const MIN_KEY_LEN = 16;

function suffixOf(rawKey) {
  return rawKey.slice(-4);
}

// Replace any existing key for this user with a freshly-encrypted one.
export async function saveOpenRouterKey(userId, rawKey, label = 'OpenRouter') {
  const key = String(rawKey || '').trim();
  if (key.length < MIN_KEY_LEN) {
    const err = new Error('That does not look like a valid API key.');
    err.status = 400;
    throw err;
  }

  const encrypted = encrypt(key);
  const suffix = suffixOf(key);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM api_keys WHERE user_id = $1', [userId]);
    const { rows } = await client.query(
      `INSERT INTO api_keys (user_id, encrypted_key, key_suffix, label)
       VALUES ($1, $2, $3, $4)
       RETURNING key_suffix, label, created_at`,
      [userId, encrypted, suffix, label || 'OpenRouter'],
    );
    await client.query('COMMIT');
    return { hasKey: true, suffix: rows[0].key_suffix, label: rows[0].label, createdAt: rows[0].created_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Metadata only — safe to return to the client. Never includes the key itself.
export async function getKeyMeta(userId) {
  const { rows } = await pool.query(
    `SELECT key_suffix, label, created_at
       FROM api_keys WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!rows.length) return { hasKey: false };
  return { hasKey: true, suffix: rows[0].key_suffix, label: rows[0].label, createdAt: rows[0].created_at };
}

// Server-side only: decrypt the stored key for outbound OpenRouter calls
// (used in later steps). Returns null if the user has no key on file.
export async function getDecryptedKey(userId) {
  const { rows } = await pool.query(
    `SELECT encrypted_key FROM api_keys WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!rows.length) return null;
  return decrypt(rows[0].encrypted_key);
}

export async function deleteKey(userId) {
  const { rowCount } = await pool.query('DELETE FROM api_keys WHERE user_id = $1', [userId]);
  return rowCount > 0;
}
