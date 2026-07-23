import 'dotenv/config';
import path from 'node:path';

// Central place to read + validate environment configuration.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const encryptionKey = required('ENCRYPTION_KEY');
if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8000),
  databaseUrl: required('DATABASE_URL'),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  encryptionKey,
  sessionSecret: required('SESSION_SECRET'),

  // Cookies: secure=true requires HTTPS. Default from NODE_ENV, overridable.
  cookieSecure:
    process.env.COOKIE_SECURE != null
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production',

  trustedDeviceDays: Number(process.env.TRUSTED_DEVICE_DAYS || 30),

  // OpenRouter API. Base URL is overridable for tests/mocks. The title/referer
  // are optional attribution headers OpenRouter uses for app rankings.
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  openrouterTitle: process.env.OPENROUTER_APP_TITLE || 'mmchat',
  openrouterReferer: process.env.OPENROUTER_APP_URL || '',

  // Local media storage (uploaded input now; generated output in Step 7). Files
  // live under storageDir/<userId>/; the dir is gitignored.
  storageDir: process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : path.resolve(process.cwd(), 'storage'),
  // 5 GB per-user local cap, with an in-app notice at 3.5 GB (bible thresholds).
  maxLocalBytes: Number(process.env.MAX_LOCAL_BYTES || 5 * 1024 * 1024 * 1024),
  noticeLocalBytes: Number(process.env.NOTICE_LOCAL_BYTES || 3.5 * 1024 * 1024 * 1024),
  // Per-attachment upload ceiling (bytes) and max attachments per message.
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024),
  maxAttachments: Number(process.env.MAX_ATTACHMENTS || 6),
};
