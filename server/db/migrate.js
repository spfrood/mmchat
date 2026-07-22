#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Minimal forward-only SQL migration runner.
//
//   node db/migrate.js up       apply all pending migrations (default)
//   node db/migrate.js status   list applied / pending migrations
//
// Migrations live in db/migrations/*.sql and run in filename order. Each is
// applied inside a transaction and recorded in the schema_migrations table, so
// re-running is safe and only pending files execute.
// ─────────────────────────────────────────────────────────────────────────
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function loadMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text        PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function runUp(client) {
  await ensureMigrationsTable(client);
  const files = await loadMigrationFiles();
  const applied = await appliedSet(client);
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log('[migrate] nothing to do — database is up to date.');
    return;
  }

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] applying ${file} ...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] ✓ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  console.log(`[migrate] done — applied ${pending.length} migration(s).`);
}

async function runStatus(client) {
  await ensureMigrationsTable(client);
  const files = await loadMigrationFiles();
  const applied = await appliedSet(client);
  console.log('[migrate] status:');
  for (const file of files) {
    console.log(`  ${applied.has(file) ? '✓ applied' : '· pending'}  ${file}`);
  }
}

async function main() {
  const cmd = process.argv[2] || 'up';
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    if (cmd === 'up') await runUp(client);
    else if (cmd === 'status') await runStatus(client);
    else {
      console.error(`Unknown command: ${cmd}. Use "up" or "status".`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] error:', err.message);
  process.exit(1);
});
