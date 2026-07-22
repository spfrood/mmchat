import pg from 'pg';
import { config } from './config.js';

// Shared connection pool for the whole backend.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

pool.on('error', (err) => {
  // Don't crash the process on an idle-client error; log and let the pool recover.
  console.error('[db] unexpected idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

// Lightweight readiness probe used by the health-check route.
export async function pingDatabase() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
