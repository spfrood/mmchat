import { hash, verify } from '@node-rs/argon2';

// Argon2id password hashing. @node-rs/argon2 ships prebuilt binaries (no
// node-gyp build), and uses safe argon2id defaults.

export function hashPassword(plaintext) {
  return hash(plaintext);
}

export async function verifyPassword(storedHash, plaintext) {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    // Malformed hash or verify error → treat as a failed match, never throw.
    return false;
  }
}
