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

  // Video generation (async). Cap on concurrent pending video jobs per user —
  // the Spend Protection backstop (bible); the disabled button + idempotency key
  // are the primary duplicate-spend guard.
  maxConcurrentVideos: Number(process.env.MAX_CONCURRENT_VIDEOS || 2),

  // Cloud storage — Google Drive (Step 8). OAuth client credentials come from a
  // Google Cloud project; PUBLIC_BASE_URL is the app's externally-reachable
  // origin, used to build the OAuth redirect URI. All optional — if unset, Drive
  // simply isn't offered in Settings. The Google endpoint base URLs are
  // overridable so the OAuth/API/upload calls can be pointed at a mock in tests.
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  googleAuthBase: (process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com').replace(/\/$/, ''),
  googleOauthBase: (process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com').replace(/\/$/, ''),
  googleApiBase: (process.env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/$/, ''),
};
