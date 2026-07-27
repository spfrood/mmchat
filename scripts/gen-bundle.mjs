import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Repo root is the parent of this script's dir, so the generator is portable
// (works from a hook, an npm script, or a direct `node` invocation).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'mmchat-bundle.md');
const SELF = 'mmchat-bundle.md'; // never bundle the bundle itself

// File list from `git ls-files` (tracked only — so gitignored .env / build
// output / storage never appear). readFileSync reads the working tree, so the
// bundle reflects the CURRENT state (incl. staged-but-uncommitted edits).
// Belt-and-suspenders: drop the lockfile, the bundle itself, and any *real*
// .env that somehow became tracked (.env.example placeholders are kept).
const isRealEnv = (f) => {
  const b = path.basename(f);
  return b === '.env' || (b.startsWith('.env.') && !b.endsWith('.example'));
};
const files = execSync('git ls-files', { cwd: REPO })
  .toString()
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => f !== 'package-lock.json')
  .filter((f) => f !== SELF)
  .filter((f) => !isRealEnv(f));

// ── secret guard ────────────────────────────────────────────────────────────
// High-confidence credential patterns. If any tracked file trips these, we
// ABORT (non-zero exit) so the pre-commit hook blocks the commit instead of
// baking a secret into the shared bundle. Tuned to ignore the .env.example
// placeholders ("replace-with-…", which are not hex/token-shaped).
const SECRET_PATTERNS = [
  [/sk-or-v1-[A-Za-z0-9]{20,}/, 'OpenRouter API key (sk-or-v1-…)'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'OpenAI-style secret key (sk-…)'],
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, 'PEM private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  // A KEY/SECRET/TOKEN/PASSWORD assigned a long hex/token value (real, not the
  // word-and-hyphen placeholders in .env.example).
  [/(?:ENCRYPTION_KEY|SECRET|TOKEN|PASSWORD|API_?KEY)\s*[:=]\s*['"]?[0-9a-fA-F]{48,}/i, 'long hex secret assignment'],
];

function scanForSecrets(fileList) {
  const hits = [];
  for (const f of fileList) {
    let content;
    try { content = readFileSync(path.join(REPO, f), 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      for (const [re, label] of SECRET_PATTERNS) {
        if (re.test(line)) hits.push(`${f}:${i + 1}  (${label})`);
      }
    });
  }
  return hits;
}

const secretHits = scanForSecrets(files);
if (secretHits.length) {
  console.error('\n✖ gen-bundle: refusing to write — possible secret(s) in tracked files:');
  for (const h of secretHits) console.error('   ' + h);
  console.error('\nRemove/rotate the secret (or move it to a gitignored .env) before committing.\n');
  process.exit(1);
}

// ── language map ────────────────────────────────────────────────────────────
function langFor(f) {
  const base = path.basename(f);
  const ext = path.extname(f).toLowerCase();
  if (base === '.gitignore') return 'gitignore';
  if (base.endsWith('.env.example')) return 'ini';
  switch (ext) {
    case '.js': return 'javascript';
    case '.jsx': return 'jsx';
    case '.mjs': return 'javascript';
    case '.json': return 'json';
    case '.css': return 'css';
    case '.sql': return 'sql';
    case '.md': return 'markdown';
    case '.html': return 'html';
    case '.sh': return 'bash';
    default: return 'text';
  }
}

// Choose a fence longer than any backtick run inside the file (min 3), so files
// that themselves contain ``` blocks (the markdown docs) can't break out.
function fenceFor(content) {
  let max = 0;
  for (const m of content.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(Math.max(3, max + 1));
}

// ── ASCII tree from the flat path list ──────────────────────────────────────
function buildTree(paths) {
  const root = {};
  for (const p of paths) {
    let node = root;
    for (const part of p.split('/')) {
      node.children ??= {};
      node.children[part] ??= {};
      node = node.children[part];
    }
    node.__file = true;
  }
  const lines = [];
  function walk(node, prefix) {
    const entries = Object.entries(node.children || {});
    // directories first, then files, each alphabetical
    entries.sort(([an, a], [bn, b]) => {
      const ad = a.children ? 0 : 1;
      const bd = b.children ? 0 : 1;
      return ad - bd || an.localeCompare(bn);
    });
    entries.forEach(([name, child], i) => {
      const last = i === entries.length - 1;
      const isDir = Boolean(child.children);
      lines.push(`${prefix}${last ? '└── ' : '├── '}${name}${isDir ? '/' : ''}`);
      if (isDir) walk(child, `${prefix}${last ? '    ' : '│   '}`);
    });
  }
  walk(root, '');
  return lines.join('\n');
}

const ARCHITECTURE = `## 2. System Architecture & Tech Stack

**mmchat** is a BYOK (bring-your-own-key) multi-user web chat client for comparing
outputs across LLMs, image-generation, and video-generation models via
**OpenRouter**. Comparison is manual (one model per chat; open another tab for a
second model). Invite-only, multi-user, not publicized.

### Repository shape
- **npm workspaces monorepo** — root \`package.json\` orchestrates two workspaces:
  \`client/\` (React + Vite) and \`server/\` (Node + Express). Dev is run with
  \`concurrently\` via \`npm run dev\` / \`npm run dev:proxy\`.

### Frontend (\`client/\`)
- **React 18 + Vite 6**, \`react-router-dom\` for routing (ESM, JSX).
- Plain hand-written CSS (\`src/styles.css\`) — no UI framework.
- State via React Context: \`AuthContext\` (session user), \`ChatsContext\` (chat list),
  \`StorageContext\` (local-storage usage banner).
- **Server-Sent Events** for streaming text completions, consumed with a \`fetch\`
  \`ReadableStream\` reader (\`src/chat/stream.js\`) — not EventSource, so POST + cookies work.
- A thin \`fetch\` wrapper (\`src/api.js\`) hitting same-origin \`/api\`; cookies included
  (and \`FormData\` passed through as-is for multipart uploads). Dev proxies
  \`/api\` → backend and (behind nginx) serves the SPA.

### Backend (\`server/\`)
- **Node.js (ESM, \`"type":"module"\`) + Express.**
- **Sessions:** \`express-session\` + \`connect-pg-simple\` (Postgres-backed \`sessions\`
  table). httpOnly/secure/sameSite=lax cookies — **no JWT, no localStorage tokens**.
- **Security:** \`helmet\`, \`cookie-parser\` (signed cookies), \`express-rate-limit\` on
  login/register/TOTP, an Origin-based CSRF check on state-changing requests.
- **Uploads:** \`multer\` (memory storage) for image input — used in all three
  modalities (vision text, image-to-image reference, image-to-video first frame).
- Layered by feature: \`auth/\`, \`chats/\` (text \`completion\`, \`imagegen\`, \`videogen\`),
  \`keys/\` (BYOK key), \`openrouter/\` (API client + catalogue routes), \`media/\`
  (serve files), \`storage/\` (local accounting + cloud), \`account/\` (settings menu),
  \`crypto/\` (encryption + token hashing).

### Auth
- **argon2id** password hashing (\`@node-rs/argon2\`, prebuilt binaries).
- **TOTP 2FA** (\`otplib\`) with QR enrollment (\`qrcode\`) and one-time backup codes
  (hashed at rest). TOTP secret encrypted at rest.
- **Trusted-device** signed httpOnly cookie (token hashed server-side, 30-day
  default) lets a known browser skip TOTP; revocable individually or in bulk
  (password change / admin reset).
- **Invite-only registration** — admins mint single-use, hashed, expiring invite
  tokens (CLI or route); no email service exists anywhere in the app.
- **Manual recovery** via CLI (\`scripts/reset-user.js\`) / raw SQL — no reset emails.

### Crypto
- **AES-256-GCM** (Node \`crypto\`) with a server-side master key (\`ENCRYPTION_KEY\`)
  encrypts the OpenRouter key and Google Drive refresh tokens at rest
  (\`crypto/encryption.js\`). SHA-256 for hashing invite/trusted-device/backup tokens
  (\`crypto/tokens.js\`). Secrets are never logged or returned (key shows last-4 only).

### External APIs
- **OpenRouter (BYOK — the user's own key as bearer, no server key):**
  - Text: \`GET /models\`, \`POST /chat/completions\` (SSE streaming, \`include_usage\`).
    Image input via \`image_url\` content parts (vision).
  - Image: dedicated \`GET /images/models\` (+ per-model \`/endpoints\` pricing),
    \`POST /images\` (Unified Image API). Image-to-image via \`input_references\`.
  - Video: dedicated \`GET /videos/models\`, \`POST /videos\` — **asynchronous**:
    \`202 {id, polling_url}\` then polled via \`GET /videos/{id}\` (no webhook used).
    Image-to-video via \`frame_images\` (\`frame_type:'first_frame'\`).
  - Credits: \`GET /auth/key\` for the pre-flight balance check + settings display.
  - Errors are classified into user-actionable buckets (key / credits / model).
  - Per-model **image-input capability** is looked up per modality against the
    matching catalogue (\`/api/models/capabilities?id=&modality=\`): \`input_modalities\`
    on \`/models\` and \`/images/models\`; \`supported_frame_images\` on \`/videos/models\`.
- **Google Drive** (the one supported cloud provider) — raw REST over \`fetch\` (no
  SDK), OAuth2 authorization-code with \`drive.file\` scope into an app-created
  \`mmchat\` folder. Mockable base URLs for tests.

### Data storage
- **PostgreSQL 16.** Raw-SQL migrations in \`server/db/migrations/*.sql\`, applied by a
  small custom runner (\`server/db/migrate.js\`) tracked in a \`schema_migrations\` table.
  \`gen_random_uuid()\` (core, no superuser).
- **Tables:** \`users\`, \`totp_secrets\`, \`trusted_devices\`, \`invite_tokens\`,
  \`api_keys\`, \`chats\`, \`messages\`, \`media_files\`, \`storage_accounts\`, \`sessions\`.
- **Local media** on disk under \`storageDir/<userId>/\`; a denormalized
  \`users.storage_used_bytes\` counter enforces a 5 GB cap (3.5 GB notice), with a
  recompute CLI as the self-healing ground-truth reconciler. Cloud media stores only
  an external reference and doesn't count against the cap. Uploaded image **input**
  (vision / reference / first-frame) is persisted locally and counted, same as output.

### Core architectural patterns
- **BYOK + strict per-user isolation** — every query scoped to \`req.session.userId\`.
- **Server-side sessions**, SSE (not WebSocket) for one-directional streaming.
- **Spend protection:** frontend disables submit in-flight; backend idempotency
  keys; a **partial unique index** (\`messages\` pending-per-chat) blocks duplicate
  generations; a **Postgres advisory lock** guards the concurrent-video cap;
  pre-flight credit check + confirmation dialog before video.
- **cost_usd** stored per assistant/output message at generation time (prefers
  OpenRouter's reported \`usage.cost\`); the spend dashboard aggregates it.
- **Denormalized, self-healing counters** with recompute/verify utilities (local
  disk sweep; cloud out-of-band **soft-flagging** via \`media_files.unavailable_at\`).
- **Config via env** (\`server/.env\`, \`client/.env\`; \`.env.example\` committed) so
  secrets and the deployment domain stay out of the repo.

> **Build status:** built in gated stages per \`build_guide.md\` — Steps 0–8 and 11
> complete; Steps 9–10 (multi-provider priority/quotas + WebDAV) intentionally
> deferred to the bible's "Future updates". **Post-Step-11 enhancement:** image
> input across all three modalities (image-to-image + image-to-video), documented
> in the bible's "Implementation Notes → Image input across modalities".
`;

// ── assemble ────────────────────────────────────────────────────────────────
let out = '';
out += '# mmchat — Repository Bundle\n\n';
out += 'A single-document export of the entire mmchat project (source + docs) for '
     + 'long-context LLM analysis and Q&A. Auto-generated by `scripts/gen-bundle.mjs` '
     + '(regenerated on every commit by the pre-commit hook) from `git ls-files` — '
     + 'vendor/build/lockfiles and real `.env` secrets are excluded, and the generator '
     + 'aborts if a credential is detected in a tracked file. Do not edit by hand.\n\n';

out += '## 1. Topology Summary\n\n';
out += 'File tree (excludes `node_modules/`, `.git/`, build output, `package-lock.json`, '
     + 'this bundle file, and gitignored runtime dirs such as `storage/` and real `.env` files):\n\n';
out += '```text\nmmchat/\n';
out += buildTree(files).split('\n').map((l) => '  ' + l).join('\n');
out += '\n```\n\n';

out += ARCHITECTURE + '\n';

out += '## 3. Inline File Bundle\n\n';
out += `Complete source for all ${files.length} essential files, each labeled with its `
     + 'repo-relative path. Code fences are auto-sized so files containing their own '
     + '```` ``` ```` blocks (the markdown docs) render intact.\n\n';

for (const f of files) {
  const abs = path.join(REPO, f);
  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch (e) {
    content = `[unreadable: ${e.message}]`;
  }
  if (content.length && !content.endsWith('\n')) content += '\n';
  const fence = fenceFor(content);
  out += `### File: \`${f}\`\n\n`;
  out += `${fence}${langFor(f)}\n${content}${fence}\n\n`;
}

writeFileSync(OUT, out);
const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`Wrote ${OUT}`);
console.log(`${files.length} files, ${kb} KB, ${out.split('\n').length} lines`);
