import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Local disk storage for user media. Step 4 writes uploaded *input* files here;
// Step 7 will reuse the same mechanism for generated *output*. Files live under
//   <storageDir>/<userId>/<uuid><ext>
// and are referenced from media_files.file_ref as the "<userId>/<name>" relpath.

// Image types are what a user may *upload* as vision input (Step 4). Video
// types are only ever produced as generated *output* (Step 6), never uploaded —
// so isSupportedImage() checks the image set only, while extension/content-type
// resolution covers both (a written file can be an image or a video).
const IMAGE_EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
};

const VIDEO_EXT_BY_MIME = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
};

const EXT_BY_MIME = { ...IMAGE_EXT_BY_MIME, ...VIDEO_EXT_BY_MIME };

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

export function isSupportedImage(mimetype) {
  return typeof mimetype === 'string' && mimetype in IMAGE_EXT_BY_MIME;
}

function extFor(mimetype, originalName) {
  if (EXT_BY_MIME[mimetype]) return EXT_BY_MIME[mimetype];
  const e = path.extname(originalName || '').toLowerCase();
  return MIME_BY_EXT[e] ? e : '';
}

export function contentTypeFor(fileRef) {
  return MIME_BY_EXT[path.extname(fileRef).toLowerCase()] || 'application/octet-stream';
}

// Write one buffer for a user; returns { fileRef, sizeBytes }. Used for both
// uploaded input (Step 4) and generated output (Step 5) — direction lives on
// the media_files row, not the file itself.
export async function writeUserFile(userId, { buffer, mimetype, originalname }) {
  const dir = path.join(config.storageDir, userId);
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}${extFor(mimetype, originalname)}`;
  const abs = path.join(dir, name);
  await fs.writeFile(abs, buffer);
  return { fileRef: `${userId}/${name}`, sizeBytes: buffer.length };
}

// Back-compat alias (Step 4 imported this name).
export const writeInputFile = writeUserFile;

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

// Remove a user's entire local media directory (<storageDir>/<userId>/) — used
// on account deletion, after the DB rows are gone. resolveRef guards against
// traversal (userId is a session-derived uuid, but belt-and-braces). Idempotent:
// a missing directory is fine.
export async function deleteUserStorageDir(userId) {
  try {
    await fs.rm(resolveRef(String(userId)), { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
}

export function readRef(fileRef) {
  return fs.readFile(resolveRef(fileRef));
}
