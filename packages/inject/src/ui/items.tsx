import { useState } from 'react';
import type { DraftItem, LevelKind, LevelView, ProposalView, ProtocolCandidate } from '@webscoop/core/page';
import { selectorChain } from '../chain';
import { SelectorRow } from './candidates';
import { useActions } from './context';
import { Kbd } from './shell';

export type LevelName = 'proposed' | 'broader' | 'narrower';

const selectorText = (c: ProtocolCandidate | undefined) => (c ? `${c.strategy}=${c.value}` : '');

/** Selector text input: shows the primary candidate, submits typed text. */
function SelectorInput({ level, value, onSubmit }: { level: LevelKind; value: string; onSubmit: (text: string) => void }) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  // Follow the host's value when it changes (a pick, a new primary), keeping the user's typing otherwise.
  if (shown !== value) {
    setShown(value);
    setText(value);
  }
  return (
    <form
      className="ws-row ws-spacer"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = text.trim();
        if (trimmed && trimmed !== value) onSubmit(trimmed);
      }}
    >
      <input
        className="ws-input ws-input-sm ws-mono-sm ws-spacer"
        value={text}
        placeholder={level === 'within' ? 'none: containers anywhere on the page' : 'role=listitem'}
        aria-label={level === 'within' ? 'List parent selector' : 'Item selector'}
        data-ws={`level-input-${level}`}
        onChange={(e) => setText(e.target.value)}
      />
    </form>
  );
}

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
  return (
    <div className="ws-col" data-ws={`level-field-${level}`}>
      <div className="ws-row ws-row-between">
        <span className="ws-caps">{label}</span>
        {view && <span className="ws-meta ws-mono-sm ws-ellipsis">{view.label}</span>}
      </div>
      <div className="ws-row">
        <SelectorInput level={level} value={selectorText(primary)} onSubmit={(selector) => void actions.send({ kind: 'draft.setLevel', level, by: 'selector', selector })} />
        <button
          type="button"
          className="ws-btn ws-btn-sm"
          title={level === 'within' ? 'Pick the element that holds every item' : 'Pick one item inside the list parent'}
          onClick={() => void actions.send({ kind: 'draft.pickLevel', level })}
          data-ws={`level-pick-${level}`}
        >
          Pick
        </button>
        {view && view.selectors.length > 1 && (
          <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-expanded={open} onClick={() => setOpen(!open)} data-ws={`level-more-${level}`}>
            {view.selectors.length}
          </button>
        )}
        {onClear && view && (
          <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Clear ${label.toLowerCase()}`} onClick={onClear} data-ws={`level-clear-${level}`}>
            ×
          </button>
        )}
      </div>
      {error && (
        <span className="ws-error" data-ws={`level-error-${level}`}>
          {error}
        </span>
      )}
      {open && view && (
        <div className="ws-list" role="listbox" aria-label={`${label} candidates`} data-ws={`level-candidates-${level}`}>
          {view.selectors.map((c, i) => (
            <SelectorRow
              key={`${c.strategy}=${c.value}`}
              candidate={c}
              primary={i === view.primary}
              onChoose={() => void actions.send({ kind: 'draft.setPrimary', level, index: i, ...(rung && rung !== 'proposed' ? { rung } : {}) })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The composed chain of primary selectors, from the list parent down; display only. */
export function SelectorChain({ chain }: { chain: string }) {
  if (!chain) return null;
  return (
    <div className="ws-row" data-ws="selector-chain">
      <span className="ws-caps">Chain</span>
      <span className="ws-mono-sm ws-ellipsis ws-spacer" title={chain} data-ws="selector-chain-text">
        {chain}
      </span>
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
  const [value, setValue] = useState('');
  const submit = () => {
    const selector = value.trim();
    if (!selector) return;
    void actions.send({ kind: 'draft.addExclusion', selector });
    setValue('');
  };
  return (
    <div className="ws-col">
      <span className="ws-caps">Exclude</span>
      {exclude.map((c, i) => (
        <div key={`${c.value}-${i}`} className="ws-row" data-ws="exclusion">
          <span className="ws-mono-sm ws-spacer ws-ellipsis">{c.value}</span>
          <span className="ws-num">{c.count ?? '…'}</span>
          <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Remove exclusion ${c.value}`} onClick={() => void actions.send({ kind: 'draft.removeExclusion', index: i })}>
            ×
          </button>
        </div>
      ))}
      <form
        className="ws-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className="ws-input ws-input-sm ws-mono-sm"
          placeholder=".sponsored"
          value={value}
          aria-label="Exclusion selector"
          data-ws="exclude-input"
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="ws-btn ws-btn-sm" data-ws="exclude-add">
          Exclude
        </button>
      </form>
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
        <span className="ws-caps">Repeating items found</span>
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
      <SelectorChain chain={selectorChain([proposal.within?.selectors[proposal.within.primary], chosen.selectors[chosen.primary]])} />
      <div className="ws-row">
        <span className="ws-meta ws-spacer">Include all siblings</span>
        <Toggle on={proposal.includeAll} onChange={() => void actions.send({ kind: 'draft.toggleIncludeAll' })} label="Include all siblings" testId="include-all" />
      </div>
      <SampleRowList samples={chosen.samples} />
      <ContainerLadder proposal={proposal} level={level} onChoose={onLevel} />
      <ExclusionInput exclude={proposal.exclude} />
      <div className="ws-row">
        <button type="button" className="ws-btn ws-btn-primary ws-spacer" onClick={() => void actions.send({ kind: 'draft.confirmItems', level })} data-ws="confirm-items">
          Use these {chosen.count ?? ''} items <Kbd>Enter</Kbd>
        </button>
        <button type="button" className="ws-btn ws-btn-ghost" onClick={() => void actions.send({ kind: 'draft.cancelItems' })} data-ws="cancel-items">
          Not a list
        </button>
      </div>
    </section>
  );
}

/** The confirmed item's list parent: its selector and match count, re-pick, and clear. */
export function WithinSummary({ item }: { item: DraftItem }) {
  const actions = useActions();
  const primary = item.within?.[0];
  return (
    <div className="ws-row" data-ws="within-summary">
      <span className="ws-caps">List parent</span>
      <span className="ws-mono-sm ws-ellipsis ws-spacer" data-ws="within-selector">
        {primary ? selectorText(primary) : 'none'}
      </span>
      {primary && (
        <span className="ws-num" data-ws="within-count" title="Matches of the list parent selector on this page">
          {item.withinCount ?? '…'}
        </span>
      )}
      <button type="button" className="ws-btn ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.pickLevel', level: 'within' })} data-ws="within-repick">
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
          ×
        </button>
      )}
    </div>
  );
}

/** The confirmed item container, with its list parent and exclusions. */
export function ItemSummary({ item }: { item: DraftItem }) {
  const actions = useActions();
  const primary = item.selectors[0]!;
  return (
    <section className="ws-card" data-ws="item-summary">
      <div className="ws-row ws-row-between">
        <span className="ws-caps">Items</span>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.clearItem' })} data-ws="clear-item">
          Remove
        </button>
      </div>
      <div className="ws-row">
        <span className="ws-count" data-ws="item-count">
          {item.count ?? '…'}
        </span>
        <div className="ws-col">
          <span className="ws-mono-sm ws-ellipsis">{`${primary.strategy}=${primary.value}`}</span>
          {item.total !== null && item.total !== item.count && <span className="ws-meta">{item.total} before exclusions</span>}
        </div>
      </div>
      <WithinSummary item={item} />
      <SelectorChain chain={selectorChain([item.within?.[0], primary])} />
      <ExclusionInput exclude={item.exclude} />
    </section>
  );
}
