#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Manual account recovery CLI (run on the server with DB access).
//
//   node scripts/reset-user.js --email a@b.com --password 'NewPass123'
//   node scripts/reset-user.js --email a@b.com --reset-totp
//   node scripts/reset-user.js --email a@b.com --password 'x' --reset-totp
//   node scripts/reset-user.js --email a@b.com --make-admin
//
// --password    set a new password (argon2). Also revokes trusted devices.
// --reset-totp  clear TOTP so the user re-enrolls a fresh authenticator on
//               next login (login → "set up authenticator" → verify).
// --make-admin / --remove-admin  toggle the admin flag.
//
// Any password or TOTP change also revokes all of the user's trusted devices,
// forcing a full re-auth.
// ─────────────────────────────────────────────────────────────────────────
import { pool } from '../src/db.js';
import { hashPassword } from '../src/auth/password.js';
import { revokeAllTrustedDevices } from '../src/auth/trustedDevice.js';

function parseArgs(argv) {
  const args = { email: null, password: null, resetTotp: false, makeAdmin: false, removeAdmin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') args.email = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--password') args.password = argv[++i];
    else if (a === '--reset-totp') args.resetTotp = true;
    else if (a === '--make-admin') args.makeAdmin = true;
    else if (a === '--remove-admin') args.removeAdmin = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) {
    console.error('Usage: reset-user.js --email <email> [--password <new>] [--reset-totp] [--make-admin|--remove-admin]');
    process.exit(1);
  }

  const { rows } = await pool.query('SELECT id, email, is_admin FROM users WHERE email = $1', [args.email]);
  if (!rows.length) {
    console.error(`No user with email ${args.email}`);
    process.exit(1);
  }
  const user = rows[0];
  const did = [];

  if (args.password) {
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await hashPassword(String(args.password)),
      user.id,
    ]);
    did.push('password reset');
  }

  if (args.resetTotp) {
    // Deleting the row forces re-enrollment on next login.
    await pool.query('DELETE FROM totp_secrets WHERE user_id = $1', [user.id]);
    did.push('TOTP cleared (user must re-enroll)');
  }

  if (args.makeAdmin || args.removeAdmin) {
    await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [Boolean(args.makeAdmin), user.id]);
    did.push(args.makeAdmin ? 'granted admin' : 'revoked admin');
  }

  if (args.password || args.resetTotp) {
    await revokeAllTrustedDevices(user.id);
    did.push('trusted devices revoked');
  }

  console.log(`\nUser ${user.email} (${user.id}):`);
  console.log(did.length ? did.map((d) => `  - ${d}`).join('\n') : '  (no changes — pass an action flag)');
  console.log('');
  await pool.end();
}

main().catch(async (err) => {
  console.error('reset-user failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
