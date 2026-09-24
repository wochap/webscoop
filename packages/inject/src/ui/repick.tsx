import type { RepickContext } from '@webscoop/core/page';
import { Kbd } from './shell';

/** Score as a percentage-like number with two decimals, e.g. `0.87`. */
export function formatScore(score: number): string {
  return score.toFixed(2);
}

/** Horizontal bar for a score from 0 to 1, with the threshold marked. */
export function ScoreBar({ score, threshold }: { score: number | null; threshold: number }) {
  const likely = score !== null && score >= threshold;
  return (
    <div className="ws-row" data-ws="score" data-likely={String(likely)}>
      <div className="ws-scorebar" aria-hidden="true">
        <div className={`ws-scorebar-fill${likely ? ' ws-scorebar-likely' : ''}`} style={{ width: `${Math.round((score ?? 0) * 100)}%` }} />
        <div className="ws-scorebar-threshold" style={{ left: `${Math.round(threshold * 100)}%` }} title={`Threshold ${formatScore(threshold)}`} />
      </div>
      <span className="ws-num" data-ws="score-value">
        {score === null ? '–' : formatScore(score)}
      </span>
      {likely && (
        <span className="ws-badge ws-tone-ok" data-ws="likely">
          likely
        </span>
      )}
    </div>
  );
}

/** The stored fingerprint of the field being re-picked, and the live score of the hovered element. */
export function FingerprintCard({ context, hoverScore }: { context: RepickContext; hoverScore: number | null }) {
  const fp = context.fingerprint;
  return (
    <section className="ws-card ws-col" data-ws="fingerprint">
      <span className="ws-caps">Was</span>
      <span className="ws-mono-sm ws-ellipsis" title={`${context.oldSelector.strategy}=${context.oldSelector.value}`} data-ws="old-selector">
        {context.oldSelector.strategy}={context.oldSelector.value}
      </span>
      <div className="ws-row">
        <span className="ws-meta">sample</span>
        <span className="ws-ellipsis ws-spacer" data-ws="old-sample">
          {context.sample ?? '—'}
        </span>
      </div>
      {fp ? (
        <>
          <div className="ws-row">
            <span className="ws-meta">tag</span>
            <span className="ws-mono-sm" data-ws="fp-tag">
              {fp.tag}
              {fp.role ? ` · ${fp.role}` : ''}
            </span>
          </div>
          <div className="ws-row">
            <span className="ws-meta">text</span>
            <span className="ws-ellipsis ws-spacer" data-ws="fp-text">
              {fp.textSample || '—'}
            </span>
          </div>
          <div className="ws-row">
            <span className="ws-meta">in</span>
            <span className="ws-mono-sm ws-ellipsis ws-spacer" data-ws="fp-ancestors">
              {[...fp.ancestors].reverse().join(' › ')}
            </span>
          </div>
          <span className="ws-caps">Hovered element</span>
          <ScoreBar score={hoverScore} threshold={context.threshold} />
        </>
      ) : (
        <span className="ws-meta" data-ws="no-fingerprint">
          No fingerprint was stored for this field, so hovered elements cannot be scored.
        </span>
      )}
    </section>
  );
}

/** The focused re-pick body: what to click, what the field looked like, and the pick waiting for confirmation. */
export function RepickPanel({
  context,
  hoverScore,
  picking,
  onPick,
  onCancel,
}: {
  context: RepickContext;
  hoverScore: number | null;
  picking: boolean;
  onPick: () => void;
  onCancel: () => void;
}) {
  const picked = context.picked;
  return (
    <div className="ws-col" data-ws="repick" data-reason={context.reason}>
      <div className={`ws-strip${picking ? ' ws-strip-active' : ''}`} data-ws="repick-prompt" data-picking={String(picking)}>
        <div className="ws-col ws-spacer">
          <span className="ws-title">
            Click the new location of <span className="ws-mono">{context.field}</span>
          </span>
          <span className="ws-meta">
            {context.reason === 'run' ? 'The run is waiting. ' : ''}
            <Kbd>S</Kbd> skips · <Kbd>Esc</Kbd> {picking ? 'stops picking' : 'aborts'}
          </span>
        </div>
        {picking ? (
          <button type="button" className="ws-btn ws-btn-sm" onClick={onCancel} data-ws="pick-cancel">
            Stop
          </button>
        ) : (
          <button type="button" className="ws-btn ws-btn-sm" onClick={onPick} data-ws="pick">
            Pick <Kbd>P</Kbd>
          </button>
        )}
      </div>
      <FingerprintCard context={context} hoverScore={hoverScore} />
      {picked && (
        <section className="ws-card ws-card-accent ws-col" data-ws="picked">
          <span className="ws-caps">New</span>
          <span className="ws-mono-sm ws-ellipsis" data-ws="picked-selector">
            {picked.selector.strategy}={picked.selector.value}
          </span>
          <div className="ws-row">
            <span className="ws-meta">sample</span>
            <span className="ws-ellipsis ws-spacer" data-ws="picked-sample">
              {picked.sample ?? '—'}
            </span>
          </div>
          {picked.score !== null && <ScoreBar score={picked.score} threshold={context.threshold} />}
        </section>
      )}
    </div>
  );
}

export function RepickFooter({
  canConfirm,
  reason,
  onConfirm,
  onSkip,
  onAbort,
}: {
  canConfirm: boolean;
  reason: RepickContext['reason'];
  onConfirm: () => void;
  onSkip: () => void;
  onAbort: () => void;
}) {
  return (
    <footer className="ws-footer">
      <button type="button" className="ws-btn ws-btn-ghost" onClick={onAbort} data-ws="repick-abort" title={reason === 'run' ? 'Stop the run' : 'Leave without saving'}>
        Abort <Kbd>Esc</Kbd>
      </button>
      <button type="button" className="ws-btn" onClick={onSkip} data-ws="repick-skip" title="Treat the field as missing">
        Skip <Kbd>S</Kbd>
      </button>
      <span className="ws-spacer" />
      <button type="button" className="ws-btn ws-btn-primary ws-btn-lg" onClick={onConfirm} disabled={!canConfirm} data-ws="repick-confirm">
        {reason === 'run' ? 'Use and continue' : 'Use and save'}
      </button>
    </footer>
  );
}
