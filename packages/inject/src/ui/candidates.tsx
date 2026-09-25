import { useState } from 'react';
import type { ProtocolCandidate } from '@webscoop/core/page';

export function StabilityBadge({ stability }: { stability: ProtocolCandidate['stability'] }) {
  return (
    <span className={`ws-badge ws-${stability}`} data-ws="stability" data-stability={stability}>
      {stability}
    </span>
  );
}

export function SelectorRow({
  candidate,
  primary,
  onChoose,
  containers = null,
}: {
  candidate: ProtocolCandidate;
  primary: boolean;
  onChoose: () => void;
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
      {candidate.items !== undefined && containers !== null && (
        <span className="ws-meta" data-ws="candidate-items" title="Item containers holding a match">
          {candidate.items}/{containers}
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
}: {
  candidates: ProtocolCandidate[];
  primary: number;
  onPrimary: (index: number) => void;
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
      <div className="ws-list" role="listbox" aria-label="Selector candidates" data-ws="candidates">
        {candidates.map((c, i) => (
          <SelectorRow key={`${c.strategy}=${c.value}`} candidate={c} primary={i === primary} containers={containers} onChoose={() => onPrimary(i)} />
        ))}
      </div>
    </div>
  );
}

/** Typed selector text for the selection, in the `strategy=value` syntax. */
export function SelectorInput({ scope, error, onSubmit }: { scope: 'item' | 'page'; error: string | null; onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (text.trim()) onSubmit(text.trim());
  };
  return (
    <div className="ws-col" data-ws="selector-input">
      <div className="ws-row">
        <input
          className={`ws-input ws-input-sm ws-mono-sm ws-spacer${error ? ' ws-invalid' : ''}`}
          value={text}
          placeholder={scope === 'item' ? 'Selector inside each item, e.g. css=h3' : 'Selector on the page, e.g. css=h1'}
          aria-label="Selection selector"
          aria-invalid={error ? true : undefined}
          data-ws="selection-selector"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button type="button" className="ws-btn ws-btn-sm" onClick={submit} data-ws="selection-selector-go" disabled={!text.trim()}>
          Select
        </button>
      </div>
      {error && (
        <span className="ws-error" data-ws="selector-error">
          {error}
        </span>
      )}
    </div>
  );
}

/** How many item containers the primary candidate matches in, with a hint to mark a partial field optional. */
export function CoverageHint({ items, containers, optional, onOptional }: { items: number; containers: number; optional: boolean; onOptional: () => void }) {
  const partial = items < containers;
  return (
    <div className={`ws-row${partial ? ' ws-warning' : ''}`} data-ws="coverage" data-partial={partial}>
      <span className="ws-spacer ws-meta" data-ws="coverage-count">
        {items} / {containers} items
      </span>
      {partial && !optional && (
        <button type="button" className="ws-btn ws-btn-sm" onClick={onOptional} data-ws="coverage-optional" title="Some items have no match: keep their rows with an empty value">
          Mark optional
        </button>
      )}
    </div>
  );
}

/** Update and Cancel, in place of the action grid while a saved field is being edited. */
export function EditActions({ onUpdate, onCancel, canUpdate }: { onUpdate: () => void; onCancel: () => void; canUpdate: boolean }) {
  return (
    <div className="ws-grid2" data-ws="edit-actions">
      <button type="button" className="ws-btn ws-btn-primary" onClick={onUpdate} data-ws="update-field" disabled={!canUpdate}>
        Update field
      </button>
      <button type="button" className="ws-btn" onClick={onCancel} data-ws="cancel-edit">
        Cancel
      </button>
    </div>
  );
}

export function PickActionGrid({
  scope,
  onAddField,
  onRecordStep,
  onUseAsItems,
  onPagination,
  onDismiss,
  hasItem,
  repicking,
  canAdd = true,
}: {
  scope: 'item' | 'page';
  onAddField: () => void;
  onRecordStep: () => void;
  onUseAsItems: () => void;
  onPagination: () => void;
  onDismiss: () => void;
  hasItem: boolean;
  repicking: boolean;
  /** False while the field options have an error, such as a duplicate name. */
  canAdd?: boolean;
}) {
  return (
    <div className="ws-grid2" data-ws="actions">
      <button type="button" className="ws-btn ws-btn-primary" onClick={onAddField} data-ws="add-field" disabled={repicking || !canAdd}>
        Add as {scope} field
      </button>
      <button type="button" className="ws-btn" onClick={onUseAsItems} data-ws="use-as-items">
        {hasItem ? 'Replace item container' : 'Use as item container'}
      </button>
      <button type="button" className="ws-btn" onClick={onPagination} data-ws="mark-pagination">
        Pagination target
      </button>
      <button type="button" className="ws-btn" onClick={onRecordStep} data-ws="record-step" title="Add a step that acts on this element, without acting now">
        Record as step
      </button>
      <button type="button" className="ws-btn ws-btn-ghost" onClick={onDismiss} data-ws="dismiss">
        Pick another
      </button>
    </div>
  );
}
