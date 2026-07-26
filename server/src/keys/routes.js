import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { saveOpenRouterKey, getKeyMeta, deleteKey, getDecryptedKey } from './service.js';
import { getKeyInfo } from '../openrouter/client.js';

// /api/keys — the user's own OpenRouter API key (BYOK). All routes require a
// fully-authenticated session; every query is scoped to req.session.userId.
export const keysRouter = Router();

keysRouter.use(requireAuth);

// Current key metadata (never the key itself): { hasKey, suffix?, label?, createdAt? }
keysRouter.get('/', async (req, res) => {
  try {
    const meta = await getKeyMeta(req.session.userId);
    res.json(meta);
  } catch (err) {
    console.error('[keys] get failed:', err.message);
    res.status(500).json({ error: 'Failed to load API key status' });
  }
});

// Credit / limit info for the user's key, read live from OpenRouter's
// GET /auth/key. Powers the pre-flight balance check before video generation
// (and the future profile "view credits" link). The key itself never leaves
// the server — only the derived numbers are returned.
keysRouter.get('/credits', async (req, res) => {
  const key = await getDecryptedKey(req.session.userId);
  if (!key) return res.status(400).json({ error: 'Add your OpenRouter API key in Settings first.', category: 'key' });
  try {
    res.json(await getKeyInfo(key));
  } catch (err) {
    console.error('[keys] credits failed:', err.message);
    res.status(502).json({ error: 'Could not read your key’s credit info from OpenRouter.', category: 'key' });
  }
});

// Save / replace the key. Returns metadata only.
keysRouter.put('/', async (req, res) => {
  const { key, label } = req.body || {};
  try {
    const meta = await saveOpenRouterKey(req.session.userId, key, label);
    res.json(meta);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[keys] save failed:', err.message);
    res.status(500).json({ error: 'Failed to save API key' });
  }
});

keysRouter.delete('/', async (req, res) => {
  try {
    await deleteKey(req.session.userId);
    res.json({ hasKey: false });
  } catch (err) {
    console.error('[keys] delete failed:', err.message);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});
