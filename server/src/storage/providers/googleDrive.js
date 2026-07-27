import { config } from '../../config.js';

// Google Drive provider — raw REST over fetch (no SDK), matching the codebase's
// OpenRouter client style. Uses the least-privilege `drive.file` scope: the app
// can only see/manage files it creates, so on connect we create our own folder
// and upload into it. Access tokens are short-lived and derived on demand from
// the stored (encrypted) refresh token; this module is stateless — the accounts
// service owns token caching and encryption.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const APP_FOLDER_NAME = 'mmchat';

export function isConfigured() {
  return Boolean(config.googleClientId && config.googleClientSecret && config.publicBaseUrl);
}

export function redirectUri() {
  return `${config.publicBaseUrl}/api/storage/google/callback`;
}

// The consent URL. access_type=offline + prompt=consent guarantees a
// refresh_token is returned every time (Google omits it on silent re-auth).
export function authUrl(state) {
  const p = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${config.googleAuthBase}/o/oauth2/v2/auth?${p.toString()}`;
}

async function tokenRequest(params) {
  const r = await fetch(`${config.googleOauthBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Google token request failed (${r.status})`);
  return j;
}

// Exchange the authorization code for tokens. → { refreshToken, accessToken, expiresIn }
export async function exchangeCode(code) {
  const j = await tokenRequest({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  return { refreshToken: j.refresh_token || null, accessToken: j.access_token, expiresIn: j.expires_in };
}

// Trade the refresh token for a fresh access token. → { accessToken, expiresIn }
export async function refreshAccessToken(refreshToken) {
  const j = await tokenRequest({
    refresh_token: refreshToken,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    grant_type: 'refresh_token',
  });
  return { accessToken: j.access_token, expiresIn: j.expires_in };
}

// Best-effort revoke on disconnect (the user can also revoke from their Google
// account). Never throws — disconnect must proceed regardless.
export async function revoke(token) {
  try {
    await fetch(`${config.googleOauthBase}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch { /* ignore */ }
}

// Create a folder in the user's Drive (owned by the app under drive.file). → { id, name }
export async function createFolder(accessToken, name = APP_FOLDER_NAME) {
  const r = await fetch(`${config.googleApiBase}/drive/v3/files?fields=id,name`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Drive folder create failed (${r.status})`);
  return { id: j.id, name: j.name };
}

// Find a non-trashed folder named `name`. Under drive.file, files.list only
// returns files THIS app created, so a match can only be our own prior folder
// (never an unrelated folder of the user's). → folder id | null
export async function findFolder(accessToken, name = APP_FOLDER_NAME) {
  const q = `name = '${name.replace(/'/g, "\\'")}' and ` +
            `mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive', pageSize: '10' });
  const r = await fetch(`${config.googleApiBase}/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Drive folder search failed (${r.status})`);
  return (j.files || [])[0]?.id ?? null;
}

// Reuse the app's existing folder if one is already there, else create it — so
// reconnecting doesn't spawn duplicate `mmchat` folders. → { id, name, reused }
export async function ensureFolder(accessToken, name = APP_FOLDER_NAME) {
  const existing = await findFolder(accessToken, name);
  if (existing) return { id: existing, name, reused: true };
  const created = await createFolder(accessToken, name);
  return { id: created.id, name: created.name, reused: false };
}

// Multipart upload of a buffer into folderId. → { fileId, size }
export async function uploadFile(accessToken, { buffer, mimetype, name, folderId }) {
  const boundary = `mmchat${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name, parents: folderId ? [folderId] : undefined });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
               `--${boundary}\r\nContent-Type: ${mimetype}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), buffer, Buffer.from(tail, 'utf8')]);
  const r = await fetch(`${config.googleApiBase}/upload/drive/v3/files?uploadType=multipart&fields=id,size`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Drive upload failed (${r.status})`);
  return { fileId: j.id, size: j.size != null ? Number(j.size) : buffer.length };
}

// Reachability check for the "verify cloud files" sweep. → { exists, trashed }
// A 404 (deleted) or trashed:true both mean the file is effectively gone.
export async function getFileMeta(accessToken, fileId) {
  const r = await fetch(
    `${config.googleApiBase}/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,trashed`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (r.status === 404) return { exists: false, trashed: false };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Drive metadata failed (${r.status})`);
  return { exists: true, trashed: Boolean(j.trashed) };
}

// Download bytes for serving. Returns the raw fetch Response so the caller can
// stream it; the caller checks .status (404 → deleted out-of-band).
export function downloadFile(accessToken, fileId) {
  return fetch(
    `${config.googleApiBase}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

// Best-effort delete, used to clean up a just-uploaded file when the DB write
// that would have recorded it fails. Never throws.
export async function deleteFile(accessToken, fileId) {
  try {
    await fetch(`${config.googleApiBase}/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch { /* ignore */ }
}
