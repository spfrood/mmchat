import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from './config.js';
import { pool, pingDatabase } from './db.js';
import { csrfOriginCheck } from './auth/middleware.js';
import { authRouter } from './auth/routes.js';
import { chatsRouter } from './chats/routes.js';
import { keysRouter } from './keys/routes.js';
import { modelsRouter } from './openrouter/routes.js';

const app = express();

// Behind nginx (prod) and the Vite proxy (dev): trust the first proxy so
// secure cookies and req.ip work off X-Forwarded-* headers.
app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(config.sessionSecret));

// Postgres-backed server-side sessions (connect-pg-simple over the `sessions`
// table). Cookie is httpOnly/secure/sameSite — no tokens in localStorage.
const PgStore = connectPgSimple(session);
app.use(
  session({
    name: 'mmchat.sid',
    store: new PgStore({ pool, tableName: 'sessions', createTableIfMissing: false }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7-day session
    },
  }),
);

app.use(csrfOriginCheck);

// ── health ─────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mmchat-server', time: new Date().toISOString() });
});

app.get('/api/health/db', async (_req, res) => {
  try {
    const ok = await pingDatabase();
    res.json({ status: ok ? 'ok' : 'error', database: ok ? 'reachable' : 'unreachable' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'unreachable', message: err.message });
  }
});

// ── auth ─────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

// ── app: chats + BYOK key ──────────────────────────────────────────────────
app.use('/api/chats', chatsRouter);
app.use('/api/keys', keysRouter);
app.use('/api/models', modelsRouter);

const server = app.listen(config.port, () => {
  console.log(`[mmchat] server listening on http://localhost:${config.port} (${config.env})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

export { app };
