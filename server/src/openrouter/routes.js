import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listModels, modelSupportsImageInput } from './client.js';

// /api/models — the live OpenRouter model catalogue for the picker. Public data
// (no user key needed), but gated behind a session. Default modality is text.
export const modelsRouter = Router();

modelsRouter.use(requireAuth);

const ALLOWED = ['text', 'image', 'video', 'all'];

modelsRouter.get('/', async (req, res) => {
  const modality = ALLOWED.includes(req.query.modality) ? req.query.modality : 'text';
  try {
    const models = await listModels(modality);
    res.json({ modality, models });
  } catch (err) {
    console.error('[models] list failed:', err.message);
    res.status(502).json({ error: 'Could not reach OpenRouter to list models. Try again shortly.' });
  }
});

// Capability lookup for a single model id (used to gate the image-attach
// control). Fails soft: on any error, report no image support.
modelsRouter.get('/capabilities', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    const supportsImageInput = await modelSupportsImageInput(id);
    res.json({ id, supportsImageInput });
  } catch (err) {
    console.error('[models] capabilities failed:', err.message);
    res.json({ id, supportsImageInput: false });
  }
});
