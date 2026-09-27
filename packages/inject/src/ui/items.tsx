import { useState } from 'react';
import type { DraftItem, LevelKind, LevelView, ProposalView, ProtocolCandidate } from '@webscoop/core/page';
import { SelectorRow } from './candidates';
import { useActions } from './context';
import { Icon } from './icons';
import { SelectorChip } from './selector-chip';
import { SelectorInput } from './selector-input';
import { SelectorStack, stackLevels } from './selector-stack';
import { Kbd } from './shell';

export type LevelName = 'proposed' | 'broader' | 'narrower';

const selectorText = (c: ProtocolCandidate | undefined) => (c ? `${c.strategy}=${c.value}` : '');

/**
 * One proposal field (list parent or item container): the primary selector,
 * editable by typing or by picking on the page, and its ranked candidates.
 */
export function LevelField({
  level,
  label,
  view,
  error,
  rung,
  onClear,
}: {
  level: LevelKind;
  label: string;
  view: LevelView | null;
  error: string | null;
  rung?: LevelName;
  onClear?: () => void;
}) {
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const primary = view?.selectors[view.primary];
  const value = selectorText(primary);
  return (
    <div className="ws-col" data-ws={`level-field-${level}`}>
      <div className="ws-row ws-row-between">
        <span className="ws-caps">{label}</span>
        {view && <span className="ws-meta ws-mono-sm ws-ellipsis">{view.label}</span>}
      </div>
      <SelectorInput
        label={level === 'within' ? 'List parent selector' : 'Item selector'}
        testId={`level-input-${level}`}
        errorTestId={`level-error-${level}`}
        value={value}
        count={view?.count ?? null}
        error={error}
        placeholder={level === 'within' ? 'none: containers anywhere on the page' : 'listitem, or paste strategy=value'}
        onSubmit={(selector) => {
          if (selector !== value) void actions.send({ kind: 'draft.setLevel', level, by: 'selector', selector });
        }}
        onPick={() => void actions.send({ kind: 'draft.pickLevel', level })}
        pickTestId={`level-pick-${level}`}
        {...(view && view.selectors.length > 1 ? { candidates: view.selectors.length, candidatesOpen: open, onCandidates: () => setOpen(!open), candidatesTestId: `level-more-${level}` } : {})}
        extra={
          onClear && view ? (
            <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Clear ${label.toLowerCase()}`} onClick={onClear} data-ws={`level-clear-${level}`}>
              <Icon name="x" size={11} />
            </button>
          ) : undefined
        }
      />
      {open && view && (
        <div className="ws-list" role="listbox" aria-label={`${label} candidates`} data-ws={`level-candidates-${level}`}>
          {view.selectors.map((c, i) => (
            <SelectorRow
              key={`${c.strategy}=${c.value}`}
              candidate={c}
              primary={i === view.primary}
              level={level === 'within' ? 'list' : 'item'}
              onChoose={() => void actions.send({ kind: 'draft.setPrimary', level, index: i, ...(rung && rung !== 'proposed' ? { rung } : {}) })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Toggle({ on, onChange, label, testId }: { on: boolean; onChange: (on: boolean) => void; label: string; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`ws-toggle${on ? ' ws-toggle-on' : ''}`}
      onClick={() => onChange(!on)}
      data-ws={testId}
    />
  );
}

export function SampleRowList({ samples }: { samples: string[] }) {
  if (samples.length === 0) return null;
  return (
    <div className="ws-samples" data-ws="samples">
      {samples.map((s, i) => (
        <span key={i} className="ws-sample ws-ellipsis" title={s}>
          {s || '(no text)'}
        </span>
      ))}
    </div>
  );
}

function LadderOption({ name, level, active, onChoose }: { name: LevelName; level: LevelView | null; active: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      className="ws-kind"
      aria-pressed={active}
      disabled={!level}
      onClick={onChoose}
      data-ws={`level-${name}`}
    >
      <span className="ws-caps">{name === 'broader' ? 'Broader' : 'Narrower'}</span>
      <span className="ws-mono-sm ws-ellipsis">{level ? level.label : 'none'}</span>
      {level && <span className="ws-meta">{level.count ?? '…'} matches</span>}
    </button>
  );
}

/** One broader and one narrower level around the proposed container. */
export function ContainerLadder({ proposal, level, onChoose }: { proposal: ProposalView; level: LevelName; onChoose: (level: LevelName) => void }) {
  return (
    <div className="ws-ladder" data-ws="ladder">
      <LadderOption name="broader" level={proposal.broader} active={level === 'broader'} onChoose={() => onChoose(level === 'broader' ? 'proposed' : 'broader')} />
      <LadderOption name="narrower" level={proposal.narrower} active={level === 'narrower'} onChoose={() => onChoose(level === 'narrower' ? 'proposed' : 'narrower')} />
    </div>
  );
}

export function ExclusionInput({ exclude }: { exclude: ProtocolCandidate[] }) {
  const actions = useActions();
  return (
    <div className="ws-col">
      <span className="ws-caps">Exclude</span>
      {exclude.map((c, i) => (
        <div key={`${c.value}-${i}`} className="ws-row" data-ws="exclusion">
          <span className="ws-spacer ws-row">
            <SelectorChip candidate={c} level="item" />
          </span>
          <span className="ws-num">{c.count ?? '…'}</span>
          <button
            type="button"
            className="ws-btn ws-btn-ghost ws-btn-sm"
            aria-label={`Remove exclusion ${c.value}`}
            onClick={() => void actions.send({ kind: 'draft.removeExclusion', index: i })}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
      <SelectorInput
        label="Exclusion selector"
        testId="exclude-input"
        placeholder="sponsored, or paste strategy=value"
        clearOnSubmit
        submitLabel="Exclude"
        onSubmit={(selector) => void actions.send({ kind: 'draft.addExclusion', selector })}
      />
    </div>
  );
}

export function ItemDetectCard({
  proposal,
  level,
  onLevel,
  highlight,
  onHighlight,
}: {
  proposal: ProposalView;
  level: LevelName;
  onLevel: (level: LevelName) => void;
  highlight: boolean;
  onHighlight: (on: boolean) => void;
}) {
  const actions = useActions();
  const chosen = proposal[level] ?? proposal.proposed;
  const error = (kind: LevelKind) => (proposal.error?.level === kind ? proposal.error.message : null);
  return (
    <section className="ws-card ws-card-accent" data-ws="items-card">
      <div className="ws-row ws-row-between">
        <span className="ws-caps">{proposal.editing ? 'Edit items' : 'Repeating items found'}</span>
        <span className="ws-row">
          <span className="ws-meta">Highlight</span>
          <Toggle on={highlight} onChange={onHighlight} label="Highlight matches" testId="highlight-toggle" />
        </span>
      </div>
      <div className="ws-row">
        <span className="ws-count" data-ws="items-count">
          {chosen.count ?? '…'}
        </span>
        <div className="ws-col">
          <span className="ws-title ws-mono">{chosen.label}</span>
          <span className="ws-meta">
            {chosen.total !== null && chosen.total !== chosen.count ? `${chosen.total} before exclusions · ` : ''}
            <span data-ws="items-skipped">{proposal.skipped} skipped as dissimilar</span>
          </span>
        </div>
      </div>
      <LevelField
        level="within"
        label="List parent"
        view={proposal.within}
        error={error('within')}
        onClear={() => void actions.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' })}
      />
      <LevelField level="item" label="Item" view={chosen} error={error('item')} rung={level} />
      <SelectorStack
        levels={stackLevels(proposal.within?.selectors[proposal.within.primary], chosen.selectors[chosen.primary], { within: proposal.within?.count ?? null, item: chosen.count })}
      />
      <div className="ws-row">
        <span className="ws-meta ws-spacer">Include all siblings</span>
        <Toggle on={proposal.includeAll} onChange={() => void actions.send({ kind: 'draft.toggleIncludeAll' })} label="Include all siblings" testId="include-all" />
      </div>
      <SampleRowList samples={chosen.samples} />
      <ContainerLadder proposal={proposal} level={level} onChoose={onLevel} />
      <ExclusionInput exclude={proposal.exclude} />
      <div className="ws-row">
        <button type="button" className="ws-btn ws-btn-primary ws-spacer" onClick={() => void actions.send({ kind: 'draft.confirmItems', level })} data-ws="confirm-items">
          {proposal.editing ? 'Update items' : `Use these ${chosen.count ?? ''} items`} <Kbd>Enter</Kbd>
        </button>
        <button type="button" className="ws-btn ws-btn-ghost" onClick={() => void actions.send({ kind: 'draft.cancelItems' })} data-ws="cancel-items">
          {proposal.editing ? 'Cancel' : 'Not a list'}
        </button>
      </div>
    </section>
  );
}

/** The confirmed item's list parent: re-pick and clear. */
export function WithinSummary({ item }: { item: DraftItem }) {
  const actions = useActions();
  const primary = item.within?.[0];
  return (
    <div className="ws-row" data-ws="within-summary">
      <span className="ws-meta ws-spacer" data-ws="within-selector" data-selector={primary ? selectorText(primary) : undefined}>
        {primary ? 'List parent' : 'No list parent: containers anywhere on the page'}
      </span>
      <button type="button" className="ws-btn ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.pickLevel', level: 'within' })} data-ws="within-repick">
        <Icon name="crosshair-simple" size={12} />
        {primary ? 'Re-pick' : 'Pick'}
      </button>
      {primary && (
        <button
          type="button"
          className="ws-btn ws-btn-ghost ws-btn-sm"
          aria-label="Clear list parent"
          onClick={() => void actions.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' })}
          data-ws="within-clear"
        >
          <Icon name="x" size={11} />
        </button>
      )}
    </div>
  );
}

/** The Rows section's content: the confirmed item container as a stack under its list parent, with its exclusions. */
export function ItemSummary({ item }: { item: DraftItem }) {
  const primary = item.selectors[0]!;
  return (
    <div className="ws-col" data-ws="item-summary">
      <SelectorStack levels={stackLevels(item.within?.[0], primary, { within: item.withinCount ?? null, item: item.count ?? '…' })} testId="rows-stack" />
      <div className="ws-row">
        <span className="ws-meta" data-ws="item-count" data-count={item.count ?? undefined}>
          {item.count ?? '…'} rows
        </span>
        {item.total !== null && item.total !== item.count && <span className="ws-meta">· {item.total} before exclusions</span>}
      </div>
      {item.count === 0 && (
        <span className="ws-error" data-ws="item-zero">
          The item container matches nothing on this page.
        </span>
      )}
      <WithinSummary item={item} />
      <ExclusionInput exclude={item.exclude} />
    </div>
  );
}

/** Edit and Remove for the confirmed item container, in the Rows section header. */
export function ItemActions({ item }: { item: DraftItem }) {
  const actions = useActions();
  return (
    <>
      {item.count !== null && item.count > 0 && (
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.editItem' })} data-ws="edit-item">
          <Icon name="pencil-simple" size={12} />
          Edit
        </button>
      )}
      <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.clearItem' })} data-ws="clear-item">
        <Icon name="trash" size={12} />
        Remove
      </button>
    </>
  );
}
