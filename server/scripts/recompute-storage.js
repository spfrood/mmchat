#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Re-sync users.storage_used_bytes to the true sum of each user's local
// media_files.size_bytes. Earlier builds only ever incremented the counter
// (never decremented on delete), so counters can drift high — this repairs them.
//
//   node scripts/recompute-storage.js                    # every user
//   node scripts/recompute-storage.js --email a@b.com    # one user
//   node scripts/recompute-storage.js --dry-run          # report only, no writes
//   node scripts/recompute-storage.js --sweep-orphans    # also delete disk orphans
//
// --sweep-orphans additionally removes files on disk that no media_files row
// references (leftovers from a crash mid-write or a failed post-commit unlink).
// Only files older than 5 minutes are swept, so an in-flight write is never hit.
// Combine with --dry-run to preview, or --email to scope the sweep to one user.
//
// Run from the server/ directory (needs the DB env from .env). Safe to re-run.
// ─────────────────────────────────────────────────────────────────────────
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import {
  listUsers,
  trueLocalBytes,
  recomputeUserStorage,
  findOrphanFiles,
  deleteOrphanFiles,
} from '../src/storage/accounting.js';

function parseArgs(argv) {
  const args = { email: null, dryRun: false, sweepOrphans: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email') args.email = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--sweep-orphans') args.sweepOrphans = true;
  }
  return args;
}

function gb(bytes) {
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

async function currentCounter(userId) {
  const { rows } = await pool.query('SELECT storage_used_bytes FROM users WHERE id = $1', [userId]);
  return rows.length ? Number(rows[0].storage_used_bytes) : 0;
}

async function main() {
  const { email, dryRun, sweepOrphans } = parseArgs(process.argv.slice(2));

  let users = await listUsers();
  if (email) {
    users = users.filter((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!users.length) {
      console.error(`No user found with email ${email}`);
      await pool.end();
      process.exit(1);
    }
  }

  console.log(`\nRecompute local storage counters${dryRun ? ' (dry run — no writes)' : ''}`);
  console.log(`Cap ${gb(config.maxLocalBytes)} · notice ${gb(config.noticeLocalBytes)}\n`);

  let changed = 0;
  for (const u of users) {
    if (dryRun) {
      const before = await currentCounter(u.id);
      const truth = await trueLocalBytes(pool, u.id);
      const delta = truth - before;
      if (delta !== 0) changed++;
      console.log(
        `${u.email.padEnd(32)} counter ${gb(before)} → true ${gb(truth)}` +
        (delta !== 0 ? `  (drift ${delta > 0 ? '+' : ''}${gb(delta)})` : '  (ok)'),
      );
    } else {
      const r = await recomputeUserStorage(u.id);
      if (!r) continue;
      if (r.before !== r.after) changed++;
      console.log(
        `${u.email.padEnd(32)} ${gb(r.before)} → ${gb(r.after)}` +
        (r.before !== r.after ? '  (corrected)' : '  (ok)'),
      );
    }
  }

  console.log(
    `\n${users.length} user(s) checked, ${changed} ${dryRun ? 'with drift' : 'corrected'}.` +
    (dryRun && changed ? '  Re-run without --dry-run to apply.' : ''),
  );

  if (sweepOrphans) {
    // Scope to the one user when --email is given; otherwise scan everyone.
    const scope = email ? { userId: users[0].id } : {};
    const orphans = await findOrphanFiles(scope);
    const bytes = orphans.reduce((n, o) => n + o.sizeBytes, 0);
    console.log(`\nDisk orphans${dryRun ? ' (dry run — no deletes)' : ''}: ${orphans.length} file(s), ${gb(bytes)}`);
    for (const o of orphans) console.log(`  ${o.relpath}  (${gb(o.sizeBytes)})`);
    if (!dryRun && orphans.length) {
      const freed = await deleteOrphanFiles(orphans);
      console.log(`Removed ${orphans.length} orphan(s), freed ${gb(freed)}.`);
    } else if (dryRun && orphans.length) {
      console.log('Re-run without --dry-run to delete these.');
    }
  }

  console.log('');
  await pool.end();
}

main().catch(async (err) => {
  console.error('recompute-storage failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
