import { Icon } from './icons';
import type { ProtocolCandidate } from '@webscoop/core/page';
import { SelectorChip, type SelectorLevel } from './selector-chip';

export function StabilityBadge({ stability }: { stability: ProtocolCandidate['stability'] }) {
  return (
    <span className={`ws-badge ws-${stability}`} data-ws="pick-candidate-stability" data-stability={stability}>
      {stability}
    </span>
  );
}

export function SelectorRow({
  candidate,
  primary,
  onChoose,
  containers = null,
  level = 'field',
}: {
  candidate: ProtocolCandidate;
  primary: boolean;
  onChoose: () => void;
  /** The level the candidate is for, which colors its chip. */
  level?: SelectorLevel;
  /** Item container count, for the coverage of an item scoped candidate. */
  containers?: number | null;
}) {
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
      data-ws="pick-candidate"
      data-strategy={candidate.strategy}
      data-primary={primary}
      data-hit={candidate.hit === undefined ? undefined : String(candidate.hit)}
    >
      <span className="ws-row ws-spacer">
        <SelectorChip candidate={candidate} level={level} />
      </span>
      <span className={`ws-num${count === 0 ? ' ws-num-zero' : ''}`} data-ws="pick-candidate-count" title="Matches on this page, counted by the browser">
        {count ?? '…'}
      </span>
      {candidate.items !== undefined && containers !== null && (
        <span className="ws-meta" data-ws="pick-candidate-items" title="Item containers holding a match">
          {candidate.items}/{containers}
        </span>
      )}
      {candidate.hit === false && (
        <span className="ws-badge ws-tone-warn" data-ws="pick-candidate-miss" title="Its first match is not the element you picked">
          reads another element
        </span>
      )}
      <StabilityBadge stability={candidate.stability} />
    </div>
  );
}

export function SelectorCandidateList({
  candidates,
  primary,
  onPrimary,
  containers = null,
  level = 'field',
}: {
  candidates: ProtocolCandidate[];
  primary: number;
  onPrimary: (index: number) => void;
  level?: SelectorLevel;
  /** Item container count, for the coverage of item scoped candidates. */
  containers?: number | null;
}) {
  if (candidates.length === 0) return <span className="ws-meta">No selector candidates for this element.</span>;
  return (
    <div className="ws-col">
      <div className="ws-row ws-row-between">
        <span className="ws-caps">Selectors</span>
        <span className="ws-caps">matches</span>
      </div>
      <div className="ws-list" role="listbox" aria-label="Selector candidates" data-ws="pick-candidates">
        {candidates.map((c, i) => (
          <SelectorRow key={`${c.strategy}=${c.value}`} candidate={c} primary={i === primary} containers={containers} level={level} onChoose={() => onPrimary(i)} />
        ))}
      </div>
    </div>
  );
}

/** How many item containers the primary candidate matches in, with a hint to mark a partial field optional. */
export function CoverageHint({ items, containers, optional, onOptional }: { items: number; containers: number; optional: boolean; onOptional: () => void }) {
  const partial = items < containers;
  return (
    <div className={`ws-row${partial ? ' ws-warning' : ''}`} data-ws="pick-coverage" data-partial={partial}>
      <span className="ws-spacer ws-meta" data-ws="pick-coverage-count">
        {items} / {containers} items
      </span>
      {partial && !optional && (
        <button type="button" className="ws-btn ws-btn-sm" onClick={onOptional} data-ws="pick-coverage-optional" title="Some items have no match: keep their rows with an empty value">
          Mark optional
        </button>
      )}
    </div>
  );
}

/** Update and Cancel, in place of the action grid while a saved field is being edited. */
export function EditActions({ onUpdate, onCancel, canUpdate }: { onUpdate: () => void; onCancel: () => void; canUpdate: boolean }) {
  return (
    <div className="ws-grid2" data-ws="pick-edit-actions">
      <button type="button" className="ws-btn ws-btn-primary" onClick={onUpdate} data-ws="pick-update" disabled={!canUpdate}>
        Update field
      </button>
      <button type="button" className="ws-btn" onClick={onCancel} data-ws="pick-cancel-edit">
        Cancel
      </button>
    </div>
  );
}

export function PickActionGrid({
  onAddField,
  onRecordStep,
  onPagination,
  onDismiss: _onDismiss,
  repicking,
  canAdd = true,
  hint,
}: {
  onAddField: () => void;
  onRecordStep: () => void;
  onPagination: () => void;
  onDismiss: () => void;
  repicking: boolean;
  /** False while the field options have an error, or the pick cannot go to the active table. */
  canAdd?: boolean;
  /** What adding does, or why it is unavailable. */
  hint?: string;
}) {
  return (
    <div className="ws-col ws-actions" data-ws="pick-actions">
      <button type="button" className="ws-btn ws-btn-outline ws-btn-wide" onClick={onAddField} data-ws="pick-add-field" disabled={repicking || !canAdd}>
        <Icon name="plus" size={12} />
        Add field
      </button>
      {hint && (
        <span className="ws-meta ws-center" data-ws="pick-add-hint">
          {hint}
        </span>
      )}
      <div className="ws-row ws-also">
        <span className="ws-meta">Also</span>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={onPagination} data-ws="pick-pagination">
          <Icon name="arrow-right" size={12} />
          Pagination target
        </button>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={onRecordStep} data-ws="pick-as-step" title="Add a step that acts on this element, without acting now">
          <Icon name="record" size={12} />
          Record as step
        </button>
      </div>
    </div>
  );
}
