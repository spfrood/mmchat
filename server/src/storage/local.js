import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Local disk storage for user media. Step 4 writes uploaded *input* files here;
// Step 7 will reuse the same mechanism for generated *output*. Files live under
//   <storageDir>/<userId>/<uuid><ext>
// and are referenced from media_files.file_ref as the "<userId>/<name>" relpath.

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
};

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
};

export function isSupportedImage(mimetype) {
  return typeof mimetype === 'string' && mimetype in EXT_BY_MIME;
}

function extFor(mimetype, originalName) {
  if (EXT_BY_MIME[mimetype]) return EXT_BY_MIME[mimetype];
  const e = path.extname(originalName || '').toLowerCase();
  return MIME_BY_EXT[e] ? e : '';
}

export function contentTypeFor(fileRef) {
  return MIME_BY_EXT[path.extname(fileRef).toLowerCase()] || 'application/octet-stream';
}

// Write one buffer for a user; returns { fileRef, sizeBytes }.
export async function writeInputFile(userId, { buffer, mimetype, originalname }) {
  const dir = path.join(config.storageDir, userId);
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}${extFor(mimetype, originalname)}`;
  const abs = path.join(dir, name);
  await fs.writeFile(abs, buffer);
  return { fileRef: `${userId}/${name}`, sizeBytes: buffer.length };
}

// Resolve a stored relpath to an absolute path, guarding against traversal.
export function resolveRef(fileRef) {
  const abs = path.resolve(config.storageDir, fileRef);
  const root = path.resolve(config.storageDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path escapes storage root');
  }
  return abs;
}

export async function deleteRef(fileRef) {
  try {
    await fs.unlink(resolveRef(fileRef));
  } catch {
    /* already gone */
  }
}

export function readRef(fileRef) {
  return fs.readFile(resolveRef(fileRef));
}
