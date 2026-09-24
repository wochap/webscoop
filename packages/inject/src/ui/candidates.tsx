import type { ProtocolCandidate } from '@webscoop/core/page';

export function StabilityBadge({ stability }: { stability: ProtocolCandidate['stability'] }) {
  return (
    <span className={`ws-badge ws-${stability}`} data-ws="stability" data-stability={stability}>
      {stability}
    </span>
  );
}

export function SelectorRow({ candidate, primary, onChoose }: { candidate: ProtocolCandidate; primary: boolean; onChoose: () => void }) {
  const count = candidate.count;
  return (
    <div
      className={`ws-list-row${primary ? ' ws-list-row-selected' : ''}`}
      role="option"
      aria-selected={primary}
      tabIndex={0}
      onClick={onChoose}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault();
          onChoose();
        }
      }}
      data-ws="candidate"
      data-strategy={candidate.strategy}
      data-primary={primary}
    >
      <span className="ws-strategy">{candidate.strategy}</span>
      <span className="ws-mono-sm ws-ellipsis ws-spacer" title={candidate.value}>
        {candidate.value}
      </span>
      <span className={`ws-num${count === 0 ? ' ws-num-zero' : ''}`} data-ws="candidate-count" title="Matches on this page, counted by the browser">
        {count ?? '…'}
      </span>
      <StabilityBadge stability={candidate.stability} />
    </div>
  );
}

export function SelectorCandidateList({
  candidates,
  primary,
  onPrimary,
}: {
  candidates: ProtocolCandidate[];
  primary: number;
  onPrimary: (index: number) => void;
}) {
  if (candidates.length === 0) return <span className="ws-meta">No selector candidates for this element.</span>;
  return (
    <div className="ws-col">
      <div className="ws-row ws-row-between">
        <span className="ws-caps">Selectors</span>
        <span className="ws-caps">matches</span>
      </div>
      <div className="ws-list" role="listbox" aria-label="Selector candidates" data-ws="candidates">
        {candidates.map((c, i) => (
          <SelectorRow key={`${c.strategy}=${c.value}`} candidate={c} primary={i === primary} onChoose={() => onPrimary(i)} />
        ))}
      </div>
    </div>
  );
}

export function PickActionGrid({
  scope,
  onAddField,
  onUseAsItems,
  onPagination,
  onDismiss,
  hasItem,
  repicking,
}: {
  scope: 'item' | 'page';
  onAddField: () => void;
  onUseAsItems: () => void;
  onPagination: () => void;
  onDismiss: () => void;
  hasItem: boolean;
  repicking: boolean;
}) {
  return (
    <div className="ws-grid2" data-ws="actions">
      <button type="button" className="ws-btn ws-btn-primary" onClick={onAddField} data-ws="add-field" disabled={repicking}>
        Add as {scope} field
      </button>
      <button type="button" className="ws-btn" onClick={onUseAsItems} data-ws="use-as-items">
        {hasItem ? 'Replace item container' : 'Use as item container'}
      </button>
      <button type="button" className="ws-btn" onClick={onPagination} data-ws="mark-pagination">
        Pagination target
      </button>
      <button type="button" className="ws-btn ws-btn-ghost" onClick={onDismiss} data-ws="dismiss">
        Pick another
      </button>
    </div>
  );
}
