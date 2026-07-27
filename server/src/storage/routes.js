import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { pool } from '../db.js';
import { getStorageStatus } from './accounting.js';
import {
  getAccount, listAccounts, saveAccount, disconnectAccount, getAccessToken,
} from './accounts.js';
import * as drive from './providers/googleDrive.js';

// /api/storage — local usage status (Step 7) plus cloud-provider linking and the
// out-of-band "verify cloud files" reconciliation (Step 8, Google Drive).
export const storageRouter = Router();

storageRouter.use(requireAuth);

// Local storage usage vs. the cap — drives the persistent notice + settings bar.
storageRouter.get('/', async (req, res) => {
  try {
    res.json(await getStorageStatus(req.session.userId));
  } catch (err) {
    console.error('[storage] status failed:', err.message);
    res.status(500).json({ error: 'Failed to load storage usage' });
  }
});

// Which providers this server can offer, and which the user has connected.
// google_drive.configured=false means the server has no OAuth client set up.
storageRouter.get('/providers', async (req, res) => {
  try {
    const account = await getAccount(req.session.userId, 'google_drive');
    res.json({
      google_drive: {
        configured: drive.isConfigured(),
        connected: Boolean(account),
        folderName: drive.APP_FOLDER_NAME,
        connectedAt: account?.connected_at ?? null,
      },
    });
  } catch (err) {
    console.error('[storage] providers failed:', err.message);
    res.status(500).json({ error: 'Failed to load cloud storage status' });
  }
});

// ── Google Drive OAuth ──────────────────────────────────────────────────────
// Begin the consent flow: stash a random state in the session (CSRF) and
// redirect the browser to Google. This is a top-level GET navigation, so the
// SameSite=Lax session cookie rides along.
storageRouter.get('/google/connect', (req, res) => {
  if (!drive.isConfigured()) {
    return res.status(400).json({ error: 'Google Drive is not configured on this server.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleOauthState = state;
  res.redirect(drive.authUrl(state));
});

// OAuth redirect target. Verify state, exchange the code, create the app folder,
// store the encrypted refresh token, then bounce back to the settings page.
storageRouter.get('/google/callback', async (req, res) => {
  const settings = `${config.publicBaseUrl || ''}/settings`;
  const fail = (reason) => res.redirect(`${settings}?cloud=google_drive&error=${encodeURIComponent(reason)}`);
  try {
    const { code, state, error } = req.query;
    if (error) return fail(String(error));
    if (!code || !state || state !== req.session.googleOauthState) return fail('invalid_state');
    delete req.session.googleOauthState;

    const { refreshToken, accessToken } = await drive.exchangeCode(String(code));
    if (!refreshToken) return fail('no_refresh_token');

    // Reuse our existing mmchat folder on reconnect rather than piling up dupes.
    const folder = await drive.ensureFolder(accessToken, drive.APP_FOLDER_NAME);
    await saveAccount({
      userId: req.session.userId,
      provider: 'google_drive',
      refreshToken,
      folderRef: folder.id,
    });
    res.redirect(`${settings}?cloud=google_drive&connected=1`);
  } catch (err) {
    console.error('[storage] google callback failed:', err.message);
    fail('connect_failed');
  }
});

// Disconnect (revoke + drop the row). Past cloud files degrade to "unavailable".
storageRouter.delete('/google', async (req, res) => {
  try {
    const ok = await disconnectAccount(req.session.userId, 'google_drive');
    res.json({ disconnected: ok });
  } catch (err) {
    console.error('[storage] google disconnect failed:', err.message);
    res.status(500).json({ error: 'Failed to disconnect Google Drive' });
  }
});

// ── Verify cloud files (out-of-band reconciliation) ─────────────────────────
// Walk this user's still-available cloud media and check each is reachable at
// the provider; flag the vanished ones unavailable (soft, kept for history).
// bytes_used recompute is Step 9 — there's no counter for cloud yet.
storageRouter.post('/verify', async (req, res) => {
  try {
    const account = await getAccount(req.session.userId, 'google_drive');
    if (!account) return res.status(400).json({ error: 'Google Drive is not connected.' });

    const { rows } = await pool.query(
      `SELECT mf.id, mf.file_ref
         FROM media_files mf
         JOIN messages m ON m.id = mf.message_id
         JOIN chats c ON c.id = m.chat_id
        WHERE c.user_id = $1 AND mf.storage_location = 'google_drive'
          AND mf.storage_account_id = $2 AND mf.unavailable_at IS NULL`,
      [req.session.userId, account.id],
    );

    let checked = 0;
    let flagged = 0;
    const token = await getAccessToken(account);
    for (const m of rows) {
      checked++;
      let meta;
      try {
        meta = await drive.getFileMeta(token, m.file_ref);
      } catch {
        continue; // transient provider error — leave as-is, try again next run
      }
      if (!meta.exists || meta.trashed) {
        await pool.query('UPDATE media_files SET unavailable_at = now() WHERE id = $1', [m.id]);
        flagged++;
      }
    }
    res.json({ checked, flagged });
  } catch (err) {
    console.error('[storage] verify failed:', err.message);
    res.status(502).json({ error: 'Could not verify cloud files. Try again shortly.' });
  }
});
