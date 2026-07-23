import { config } from '../config.js';

// Thin client over the OpenRouter REST API. BYOK: every authenticated call
// takes the user's own decrypted key as a bearer token — there is no
// server-wide key. The /models list is public and needs no key.

const BASE = config.openrouterBaseUrl;

function authHeaders(key) {
  const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (config.openrouterTitle) h['X-Title'] = config.openrouterTitle;
  if (config.openrouterReferer) h['HTTP-Referer'] = config.openrouterReferer;
  return h;
}

// Model descriptions arrive as markdown and sometimes embed links to other
// model pages. Render as plain text: turn ![alt](url) and [text](url) into
// their visible text, and drop stray markdown emphasis markers.
export function stripMarkdown(text) {
  if (!text) return '';
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // inline code
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .trim();
}

// ── models (public, cached) ────────────────────────────────────────────────
let cache = { at: 0, data: null };
const CACHE_MS = 5 * 60 * 1000;

async function rawModels() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const res = await fetch(`${BASE}/models`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Failed to load models from OpenRouter (HTTP ${res.status})`);
  }
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  cache = { at: Date.now(), data };
  return data;
}

function outputModalities(m) {
  const arch = m.architecture || {};
  if (Array.isArray(arch.output_modalities) && arch.output_modalities.length) {
    return arch.output_modalities;
  }
  // Fall back to the legacy "modality" string like "text->text" / "text+image->text".
  const mod = String(arch.modality || '');
  const out = mod.includes('->') ? mod.split('->')[1] : mod;
  return out.split('+').map((s) => s.trim()).filter(Boolean);
}

// Returns a trimmed, client-safe model list filtered by output modality.
// modality: 'text' (default) | 'image' | 'video' | 'all'.
export async function listModels(modality = 'text') {
  const data = await rawModels();
  const filtered = data.filter((m) => {
    if (modality === 'all') return true;
    return outputModalities(m).includes(modality);
  });
  return filtered
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      description: stripMarkdown(m.description),
      contextLength: m.context_length ?? m.top_provider?.context_length ?? null,
      pricing: {
        // OpenRouter prices are USD-per-token strings; pass through as-is and
        // let the client format (e.g. per-million tokens).
        prompt: m.pricing?.prompt ?? null,
        completion: m.pricing?.completion ?? null,
        request: m.pricing?.request ?? null,
        image: m.pricing?.image ?? null,
      },
      outputModalities: outputModalities(m),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── chat completions (streaming) ───────────────────────────────────────────
// Returns the raw fetch Response so the caller can inspect status (to surface
// OpenRouter errors before streaming) and then pipe the SSE body through.
export function chatCompletionStream({ key, model, messages, provider, signal }) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (provider && Object.keys(provider).length) body.provider = provider;
  return fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body),
    signal,
  });
}

// Map an OpenRouter/HTTP error to a user-facing category. The bible splits
// these into "the user must act on their key/credits" vs "try a different
// model/provider".
//   key      – invalid/revoked/missing key   -> fix the key (Settings)
//   credits  – insufficient credits / quota   -> top up / check the key's account
//   model    – model or provider unavailable  -> pick a different model
//   request  – bad request (our fault-ish)    -> generic
export function classifyError(status, orError) {
  const code = orError?.code;
  if (status === 401 || status === 403) return 'key';
  if (status === 402) return 'credits';
  if (status === 429) return 'credits'; // rate/quota limits on the user's key
  if (status === 404) return 'model';
  if (status === 502 || status === 503) return 'model'; // provider unavailable
  if (typeof code === 'number') {
    if (code === 401 || code === 403) return 'key';
    if (code === 402) return 'credits';
    if (code === 404) return 'model';
  }
  return 'request';
}

export function errorMessage(orError, fallback) {
  const msg = orError?.message || orError?.metadata?.raw;
  return (typeof msg === 'string' && msg.trim()) ? msg.trim() : fallback;
}
