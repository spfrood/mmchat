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

function inputModalities(m) {
  const arch = m.architecture || {};
  if (Array.isArray(arch.input_modalities) && arch.input_modalities.length) {
    return arch.input_modalities;
  }
  const mod = String(arch.modality || '');
  const inp = mod.includes('->') ? mod.split('->')[0] : mod;
  return inp.split('+').map((s) => s.trim()).filter(Boolean);
}

// Whether a model id accepts image input (vision). Used to gate the attach
// control and to reject image sends to text-only models.
export async function modelSupportsImageInput(modelId) {
  const data = await rawModels();
  const m = data.find((x) => x.id === modelId);
  return m ? inputModalities(m).includes('image') : false;
}

// Whether an image-GENERATION model accepts image input (image-to-image / edit).
// Image models live on their own catalogue (/images/models), NOT the chat
// catalogue, so modelSupportsImageInput (which searches /models) never finds
// them — this checks the right list.
export async function imageModelSupportsImageInput(modelId) {
  try {
    const data = await rawImageModels();
    const m = data.find((x) => x.id === modelId);
    return m ? inputModalities(m).includes('image') : false;
  } catch {
    return false;
  }
}

// Returns a trimmed, client-safe model list filtered by output modality.
// modality: 'text' (default) | 'image' | 'video' | 'all'.
// Video models live on a SEPARATE catalogue endpoint (/videos/models) rather
// than being tagged with output_modalities on /models — confirmed against the
// current OpenRouter docs — so video routes to listVideoModels().
export async function listModels(modality = 'text') {
  if (modality === 'video') return listVideoModels();
  if (modality === 'image') return listImageModels();
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
      inputModalities: inputModalities(m),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── image models (Unified Image API catalogue) ─────────────────────────────
// Image-generation models live on a dedicated /images/models endpoint (~48
// models), NOT tagged with output_modalities on the main /models list (which
// only carries ~3 image-output chat models). That endpoint carries no pricing —
// prices are on a per-model sub-endpoint — so we enrich per-image price from the
// main /models catalogue where a model appears in both, else leave it null
// ("pricing n/a"; the exact cost still shows on each generated result).
let icache = { at: 0, data: null };

async function rawImageModels() {
  if (icache.data && Date.now() - icache.at < CACHE_MS) return icache.data;
  const res = await fetch(`${BASE}/images/models`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Failed to load image models from OpenRouter (HTTP ${res.status})`);
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  icache = { at: Date.now(), data };
  return data;
}

// Run an async fn over items with a concurrency cap (used to fetch per-model
// image pricing without firing ~48 requests at once).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Cheapest output-image charge from a model's /endpoints payload, as
// { cost, unit } (USD). Pricing is an array of billable items per endpoint, e.g.
// { billable: "output_image", unit: "megapixel", cost_usd: 0.07 }; units vary
// (megapixel vs image), so we carry the unit through rather than assume per-image.
function imageOutputPricing(endpointsJson) {
  const eps = Array.isArray(endpointsJson?.endpoints) ? endpointsJson.endpoints : [];
  let best = null;
  for (const ep of eps) {
    const pricing = Array.isArray(ep?.pricing) ? ep.pricing : [];
    for (const p of pricing) {
      if (!String(p?.billable || '').toLowerCase().includes('image')) continue; // output-image charge only
      const cost = Number(p?.cost_usd);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      if (!best || cost < best.cost) best = { cost, unit: String(p?.unit || 'image').toLowerCase() };
    }
  }
  return best;
}

const imgPriceCache = new Map(); // id -> { at, price: {cost,unit}|null }

// Per-model image pricing, cached. The model id contains slashes that belong in
// the path (e.g. black-forest-labs/flux.2-max), so it is NOT url-encoded.
export async function modelImagePricing(modelId) {
  const c = imgPriceCache.get(modelId);
  if (c && Date.now() - c.at < CACHE_MS) return c.price;
  let price = null;
  try {
    const res = await fetch(`${BASE}/images/models/${modelId}/endpoints`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) price = imageOutputPricing(await res.json());
  } catch {
    price = null;
  }
  imgPriceCache.set(modelId, { at: Date.now(), price });
  return price;
}

export async function listImageModels() {
  const data = await rawImageModels();
  const prices = await mapLimit(data, 6, (m) => modelImagePricing(m.id));
  return data
    .map((m, idx) => {
      const pr = prices[idx]; // { cost, unit } | null
      return {
        id: m.id,
        name: m.name || m.id,
        description: stripMarkdown(m.description),
        contextLength: null,
        pricing: {
          prompt: null,
          completion: null,
          image: pr ? pr.cost : null,
          imageUnit: pr ? pr.unit : null,
          request: null,
        },
        outputModalities: ['image'],
        inputModalities: inputModalities(m),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── video models (separate catalogue) ──────────────────────────────────────
let vcache = { at: 0, data: null };

async function rawVideoModels() {
  if (vcache.data && Date.now() - vcache.at < CACHE_MS) return vcache.data;
  const res = await fetch(`${BASE}/videos/models`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Failed to load video models from OpenRouter (HTTP ${res.status})`);
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  vcache = { at: Date.now(), data };
  return data;
}

// Cheapest USD per SECOND of video output for a model, matching how OpenRouter
// labels these ("from $X/second" = the lowest-resolution per-second tier).
//
// Real /videos/models `pricing_skus` keys are descriptive and unit-bearing.
// Per-second families seen in the catalogue (values are USD unless the key says
// "cents_", and vary by resolution / audio / text-vs-image-to-video):
//   duration_seconds, duration_seconds_720p, duration_seconds_without_audio_4k,
//   text_to_video_duration_seconds_1080p, image_to_video_duration_seconds_720p,
//   cents_per_video_output_second_480p (← cents)
// We take the cheapest per-second tier (matching OpenRouter's "from $X/second"),
// skipping input-side charges (e.g. cents_per_image_input). Token-priced models
// (Seedance's "video_tokens") have no per-second SKU → null ("pricing n/a"); the
// real cost still lands on the completed job via usage.cost.
function videoPerSecond(m) {
  const skus = m?.pricing_skus || m?.pricing || {};
  const perSecUsd = [];
  for (const [rawK, rawV] of Object.entries(skus)) {
    const k = String(rawK).toLowerCase();
    const v = Number(rawV);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (!k.includes('second')) continue;   // per-second SKUs only
    if (k.includes('input')) continue;      // skip input-side charges
    perSecUsd.push(k.includes('cent') ? v / 100 : v); // "cents_…" keys are in cents
  }
  return perSecUsd.length ? Math.min(...perSecUsd) : null;
}

export async function modelVideoPrice(modelId) {
  try {
    const data = await rawVideoModels();
    const m = data.find((x) => x.id === modelId);
    return m ? videoPerSecond(m) : null;
  } catch {
    return null;
  }
}

export async function listVideoModels() {
  const data = await rawVideoModels();
  return data
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      description: stripMarkdown(m.description),
      contextLength: null,
      pricing: {
        prompt: null,
        completion: null,
        image: null,
        // USD per second of output (see videoPerSecond above).
        video: videoPerSecond(m),
        request: null,
      },
      resolutions: Array.isArray(m.supported_resolutions) ? m.supported_resolutions : null,
      aspectRatios: Array.isArray(m.supported_aspect_ratios) ? m.supported_aspect_ratios : null,
      outputModalities: ['video'],
      inputModalities: inputModalities(m),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Whether a video-GENERATION model accepts an input frame image (image-to-video).
// The video catalogue has its own schema (no architecture.input_modalities) —
// image-to-video capability is exposed as `supported_frame_images`, a non-empty
// array of accepted frame slots (e.g. ["first_frame"] / ["first_frame","last_frame"];
// null means text-to-video only, e.g. sora-2-pro).
export async function videoModelSupportsImageInput(modelId) {
  try {
    const data = await rawVideoModels();
    const m = data.find((x) => x.id === modelId);
    return Boolean(m && Array.isArray(m.supported_frame_images) && m.supported_frame_images.length);
  } catch {
    return false;
  }
}

// ── video generation (async: submit -> poll -> fetch bytes) ─────────────────
// Submit a job. Returns the raw Response; on success the body carries
// { id, polling_url, status }. We never wait for completion here.
// frameImages: optional array of frame objects for image-to-video, shaped
// { type:'image_url', image_url:{ url }, frame_type:'first_frame'|'last_frame' }
// (url is an HTTP(S) URL or a base64 data URI). OpenRouter carries these as
// `frame_images`; omitted entirely for plain text-to-video.
export function submitVideo({ key, model, prompt, options = {}, frameImages, signal }) {
  const body = { model, prompt, ...options };
  if (Array.isArray(frameImages) && frameImages.length) {
    body.frame_images = frameImages;
  }
  return fetch(`${BASE}/videos`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body),
    signal,
  });
}

// Poll a submitted job. Prefer the polling_url OpenRouter handed back; fall
// back to the conventional path if it wasn't provided.
export function getVideoJob({ key, jobId, pollingUrl, signal }) {
  const url = pollingUrl && /^https?:\/\//.test(pollingUrl)
    ? pollingUrl
    : `${BASE}/videos/${encodeURIComponent(jobId)}`;
  return fetch(url, { method: 'GET', headers: authHeaders(key), signal });
}

// Download the finished video bytes. unsigned_urls point back at the OpenRouter
// API and require the bearer token.
export function fetchVideoContent({ key, url, signal }) {
  return fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal });
}

// Collapse the assorted status strings a provider might return into our three
// buckets. Terminal-good -> 'completed', terminal-bad -> 'failed', else 'pending'.
export function videoStatus(json) {
  const s = String(json?.status || '').toLowerCase();
  if (['completed', 'succeeded', 'success', 'complete'].includes(s)) return 'completed';
  if (['failed', 'error', 'errored', 'cancelled', 'canceled', 'expired'].includes(s)) return 'failed';
  return 'pending'; // pending | in_progress | queued | running | processing
}

// Pull the download URL(s) out of a completed job payload.
export function extractVideoUrls(json) {
  const urls = [];
  const add = (u) => { if (typeof u === 'string' && u) urls.push(u); };
  if (Array.isArray(json?.unsigned_urls)) json.unsigned_urls.forEach(add);
  else if (Array.isArray(json?.signed_urls)) json.signed_urls.forEach(add);
  else if (Array.isArray(json?.output)) json.output.forEach((o) => add(typeof o === 'string' ? o : o?.url));
  else if (typeof json?.url === 'string') add(json.url);
  return urls;
}

// GET /auth/key — the user's own key's credit/limit info. Powers the pre-flight
// balance check before an expensive video generation (and the future profile
// "view credits" link).
export async function getKeyInfo(key) {
  const res = await fetch(`${BASE}/auth/key`, { method: 'GET', headers: authHeaders(key) });
  if (!res.ok) {
    const err = new Error(`Failed to read key info (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const d = json?.data || {};
  const limit = d.limit != null ? Number(d.limit) : null;
  const usage = d.usage != null ? Number(d.usage) : null;
  let remaining = d.limit_remaining != null ? Number(d.limit_remaining) : null;
  if (remaining == null && limit != null && usage != null) remaining = Math.max(0, limit - usage);
  return {
    label: d.label ?? null,
    usage: Number.isFinite(usage) ? usage : null,
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    isFreeTier: !!d.is_free_tier,
  };
}

// ── image generation (Unified Image API) ───────────────────────────────────
// Returns the raw fetch Response so the caller can surface OpenRouter errors
// (bad key/credits/model) the same way the chat path does.
// inputReferences: optional array of image reference objects for image-to-image
// / editing, shaped { type: 'image_url', image_url: { url } } where url is an
// HTTP(S) URL or a base64 data URI. OpenRouter carries these as `input_references`
// on POST /images; omitted entirely for plain text-to-image.
export function generateImages({ key, model, prompt, inputReferences, signal }) {
  const body = { model, prompt };
  if (Array.isArray(inputReferences) && inputReferences.length) {
    body.input_references = inputReferences;
  }
  return fetch(`${BASE}/images`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body),
    signal,
  });
}

function parseImageString(s) {
  if (typeof s !== 'string') return null;
  if (s.startsWith('data:')) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(s);
    if (m) return { b64: m[2], mime: m[1] };
    return null;
  }
  if (/^https?:\/\//.test(s)) return { url: s };
  return null;
}

// Normalize the various shapes an image response can take (OpenAI-style
// data[].b64_json / data[].url, image_url objects, or chat-style
// message.images) into a flat list of { b64?, url?, mime? }.
export function extractImages(json) {
  const out = [];
  const push = (o) => {
    if (!o) return;
    if (typeof o === 'string') { out.push(parseImageString(o)); return; }
    if (o.b64_json) { out.push({ b64: o.b64_json, mime: o.mime_type || o.content_type }); return; }
    if (o.image_url?.url) { out.push(parseImageString(o.image_url.url)); return; }
    if (o.url) { out.push(parseImageString(o.url)); return; }
  };
  if (Array.isArray(json?.data)) json.data.forEach(push);
  if (Array.isArray(json?.images)) json.images.forEach(push);
  const msg = json?.choices?.[0]?.message;
  if (Array.isArray(msg?.images)) msg.images.forEach(push);
  return out.filter(Boolean);
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
