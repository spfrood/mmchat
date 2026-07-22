import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// A session is only "fully authenticated" once both the password step AND the
// TOTP step (or a trusted-device skip) have completed. Half-states:
//   - totpPending: password ok, awaiting TOTP challenge
//   - enrollmentPending: registering, awaiting TOTP enrollment confirmation

export function isFullyAuthed(req) {
  return Boolean(req.session?.userId && req.session?.totpVerified);
}

export function requireAuth(req, res, next) {
  if (!isFullyAuthed(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!isFullyAuthed(req)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!req.session.isAdmin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
}

// Defense-in-depth CSRF check on state-changing requests. The session +
// trusted-device cookies are SameSite=Lax, so browsers already withhold them
// on cross-site POST/fetch; this additionally validates the Origin header when
// present. Same-origin XHR from the SPA always sends a matching Origin.
export function csrfOriginCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !config.corsOrigin.includes(origin)) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
}

// Rate limiters for auth endpoints (security checklist). NOTE: the default
// store is in-process memory — fine for a single process, but under PM2
// cluster mode this must be swapped for a Postgres/Redis-backed store so the
// count is shared across workers.
const limiterOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please wait and try again.' },
};

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // password + TOTP attempts per IP per window
  ...limiterOpts,
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  ...limiterOpts,
});
