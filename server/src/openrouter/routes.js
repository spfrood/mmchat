import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listModels } from './client.js';

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
