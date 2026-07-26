import { useEffect, useState } from 'react';
import { api } from '../api.js';

// USD → short label. Small amounts get more precision.
function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x >= 0.01) return `$${x.toFixed(2)}`;
  if (x >= 0.0001) return `$${x.toFixed(4)}`;
  return `$${x.toPrecision(2)}`;
}

// A nominal clip length for turning a per-second rate into an example total —
// providers apply their own default duration, so this is illustrative only.
const EXAMPLE_SECONDS = 8;

// Confirmation step before a (real, billable) video generation — bible Spend
// Protection. Reads the key's live credit balance for a pre-flight check and
// warns if an example clip would draw down a meaningful share of what's left.
// `perSecond` is USD per second of output (video is billed per video-second).
export default function VideoConfirm({ modelId, perSecond, onConfirm, onCancel }) {
  const [credits, setCredits] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api('/keys/credits')
      .then((c) => { if (alive) setCredits(c); })
      .catch((e) => { if (alive) setErr(e.message || 'Could not read credit balance.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const remaining = credits?.remaining;
  const rate = Number(perSecond);
  const hasRate = Number.isFinite(rate) && rate > 0;
  const exampleTotal = hasRate ? rate * EXAMPLE_SECONDS : null; // ~ an 8-second clip
  const share = exampleTotal != null && Number.isFinite(remaining) && remaining > 0
    ? exampleTotal / remaining
    : null;
  const bigShare = share != null && share >= 0.2;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Generate video?</h2>
          <button className="close-x" title="Close" aria-label="Close" onClick={onCancel}>✕</button>
        </div>

        <div className="confirm-body">
          <p>This submits a <strong>real, billable</strong> video generation to OpenRouter using your key.</p>
          <ul className="confirm-facts">
            <li>Model: <code>{modelId}</code></li>
            <li>
              Rate:{' '}
              {hasRate
                ? <>from <strong>~{money(rate)}/second</strong> of output <span className="muted">(cheapest resolution; ≈ {money(exampleTotal)} for an {EXAMPLE_SECONDS}s clip, more at higher res)</span></>
                : <em>not per-second for this model — cost is metered per the provider’s units and shown after it generates</em>}
            </li>
            <li>
              Credits remaining:{' '}
              {loading ? '…'
                : err ? <span className="muted">unavailable</span>
                : Number.isFinite(remaining) ? <strong>{money(remaining)}</strong>
                : credits?.limit == null ? <span className="muted">no limit set on this key</span>
                : '—'}
            </li>
          </ul>
          {bigShare && (
            <p className="warn">⚠ An {EXAMPLE_SECONDS}-second clip would use about <strong>{Math.round(share * 100)}%</strong> of your remaining credits.</p>
          )}
          <p className="muted small">
            Video jobs are asynchronous and can take several minutes. You can leave the page — the result is
            fetched and stored automatically.
          </p>
        </div>

        <div className="row-btns">
          <button className="danger-solid" onClick={onConfirm}>Generate video</button>
          <button className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
