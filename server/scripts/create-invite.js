#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Bootstrap / admin CLI to mint a one-time invite token.
//
//   node scripts/create-invite.js               # normal (non-admin) invite
//   node scripts/create-invite.js --admin       # invite that creates an admin
//   node scripts/create-invite.js --admin --expires-hours 168
//
// Run from the server/ directory (needs the DB env). This is inherently
// privileged (it has DB access), so it needs no existing admin — use it once
// with --admin to create your first account, then hand out invites either from
// here or via the in-app admin button.
// ─────────────────────────────────────────────────────────────────────────
import { pool } from '../src/db.js';
import { createInvite } from '../src/auth/invites.js';

function parseArgs(argv) {
  const args = { admin: false, expiresHours: 72 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--admin') args.admin = true;
    else if (argv[i] === '--expires-hours') args.expiresHours = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const { admin, expiresHours } = parseArgs(process.argv.slice(2));
  const invite = await createInvite({
    createdByUserId: null,
    isAdmin: admin,
    expiresInHours: expiresHours,
  });

  console.log('\nInvite created:');
  console.log('  token      :', invite.raw);
  console.log('  grants admin:', invite.is_admin);
  console.log('  expires at :', new Date(invite.expires_at).toISOString());
  console.log('\nSign-up link (open the frontend and append this path):');
  console.log(`  /register?token=${encodeURIComponent(invite.raw)}\n`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('create-invite failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
