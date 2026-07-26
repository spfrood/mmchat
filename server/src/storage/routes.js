import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { getStorageStatus } from './accounting.js';

// /api/storage — the logged-in user's local storage usage vs. the cap. Drives
// the persistent 3.5 GB notice (fetched on load, not just after the write that
// crossed the threshold) and the settings storage display.
export const storageRouter = Router();

storageRouter.use(requireAuth);

storageRouter.get('/', async (req, res) => {
  try {
    res.json(await getStorageStatus(req.session.userId));
  } catch (err) {
    console.error('[storage] status failed:', err.message);
    res.status(500).json({ error: 'Failed to load storage usage' });
  }
});
