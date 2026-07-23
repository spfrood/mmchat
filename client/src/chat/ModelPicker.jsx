import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Format an OpenRouter per-token USD price string as $/million tokens.
function perMillion(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 'free';
  const m = n * 1_000_000;
  return `$${m >= 1 ? m.toFixed(2) : m.toPrecision(2)}/M`;
}

function priceLabel(p) {
  const parts = [];
  const prompt = perMillion(p.prompt);
  const completion = perMillion(p.completion);
  if (prompt) parts.push(`in ${prompt}`);
  if (completion) parts.push(`out ${completion}`);
  const img = Number(p.image);
  if (Number.isFinite(img) && img > 0) parts.push(`img $${img.toFixed(4)}`);
  return parts.length ? parts.join(' · ') : 'pricing n/a';
}

// Modal model picker. Fetches the live catalogue for the chosen modality and
// filters client-side by a text search over name/id/description.
export default function ModelPicker({ modality = 'text', currentModelId, onSelect, onClose }) {
  const [mod, setMod] = useState(modality);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api(`/models?modality=${mod}`)
      .then((res) => { if (alive) setModels(res.models); })
      .catch((err) => { if (alive) setError(err.message || 'Failed to load models'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [mod]);

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
          <h2>Choose a model</h2>
          <button className="close-x" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div className="picker-filters">
          <input
            type="text"
            placeholder="Search models…"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={mod} onChange={(e) => setMod(e.target.value)} title="Filter by output modality">
            <option value="text">text</option>
            <option value="image">image</option>
            <option value="video">video</option>
            <option value="all">all</option>
          </select>
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
                <span className="model-name">{m.name}</span>
                <span className="model-price">{priceLabel(m.pricing)}</span>
              </div>
              <div className="model-id muted small">{m.id}</div>
              {m.description && <p className="model-desc muted small">{m.description}</p>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
