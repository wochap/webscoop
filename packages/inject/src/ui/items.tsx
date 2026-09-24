import { useState } from 'react';
import type { DraftItem, LevelView, ProposalView, ProtocolCandidate } from '@webscoop/core/page';
import { useActions } from './context';
import { Kbd } from './shell';

export type LevelName = 'proposed' | 'broader' | 'narrower';

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
            {chosen.selectors[0] ? `${chosen.selectors[0].strategy}=${chosen.selectors[0].value}` : ''}
          </span>
        </div>
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

/** The confirmed item container, with its exclusions. */
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
      <ExclusionInput exclude={item.exclude} />
    </section>
  );
}
