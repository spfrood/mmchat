import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Format an OpenRouter per-token USD price string as $/million tokens.
function perMillion(price) {
  if (price == null || price === '') return null; // absent ≠ free
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 'free';
  const m = n * 1_000_000;
  return `$${m >= 1 ? m.toFixed(2) : m.toPrecision(2)}/M`;
}

// USD with enough precision for small rates ($0.0000 is useless); never exponential.
function fmtUsd(v) {
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  if (v >= 0.0001) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

// Short label for an image billing unit (e.g. "megapixel" → "MP").
function imgUnit(u) {
  if (!u) return 'image';
  const s = String(u).toLowerCase();
  if (s.includes('megapixel') || s === 'mp') return 'MP';
  if (s.includes('token')) return 'token';
  if (s.includes('image')) return 'image';
  return s;
}

// Image rate for the picker: per-token models are metered (a tiny per-token
// number is meaningless to compare), so label them rather than print a figure.
function imgRate(cost, unit) {
  if (String(unit || '').toLowerCase().includes('token')) return 'per-token (metered)';
  return Number.isFinite(cost) && cost > 0 ? `from ${fmtUsd(cost)}/${imgUnit(unit)}` : null;
}

function priceLabel(p) {
  const parts = [];
  const prompt = perMillion(p.prompt);
  const completion = perMillion(p.completion);
  if (prompt) parts.push(`in ${prompt}`);
  if (completion) parts.push(`out ${completion}`);
  const imgLabel = imgRate(Number(p.image), p.imageUnit);
  if (imgLabel) parts.push(imgLabel);
  const vid = Number(p.video);
  if (Number.isFinite(vid) && vid > 0) parts.push(`from ${fmtUsd(vid)}/sec`);
  return parts.length ? parts.join(' · ') : 'pricing n/a';
}

// Modal model picker. Fetches the live catalogue for the chosen modality and
// filters client-side by a text search over name/id/description.
export default function ModelPicker({ modality = 'text', currentModelId, onSelect, onClose }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  // The picker only ever shows models for THIS chat's modality — a mismatched
  // pick just errors on send, so it isn't offered. The type is fixed by the chat.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api(`/models?modality=${modality}`)
      .then((res) => { if (alive) setModels(res.models); })
      .catch((err) => { if (alive) setError(err.message || 'Failed to load models'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [modality]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(needle) ||
        m.id.toLowerCase().includes(needle) ||
        (m.description || '').toLowerCase().includes(needle),
    );
  }, [models, q]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Choose a {modality} model</h2>
          <button className="close-x" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div className="picker-filters">
          <input
            type="text"
            placeholder={`Search ${modality} models…`}
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="model-list">
          {loading && <p className="muted pad">Loading models…</p>}
          {error && <p className="error pad">{error}</p>}
          {!loading && !error && filtered.length === 0 && (
            <p className="muted pad">No models match.</p>
          )}
          {!loading && !error && filtered.map((m) => (
            <button
              key={m.id}
              className={`model-item${m.id === currentModelId ? ' selected' : ''}`}
              onClick={() => { onSelect(m); onClose(); }}
            >
              <div className="model-item-head">
                <span className="model-name">
                  {m.name}
                  {m.inputModalities?.includes('image') && <span className="badge vision" title="Accepts image input">vision</span>}
                </span>
                <span className="model-price">{priceLabel(m.pricing)}</span>
              </div>
              <div className="model-id muted small">{m.id}</div>
              {m.description && <p className="model-desc muted small">{m.description}</p>}
            </button>
          ))}
        </div>

        <p className="picker-disclaimer muted small">
          Prices are estimates and <strong>may be inaccurate</strong> — verify on{' '}
          <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">openrouter.ai</a> before relying on them.
        </p>
      </div>
    </div>
  );
}
