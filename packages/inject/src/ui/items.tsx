import { useState, type ReactNode } from 'react';
import type { DraftItem, LevelKind, LevelView, Path, ProposalView, ProtocolCandidate } from '@webscoop/core/page';
import { SelectorRow } from './candidates';
import { useActions } from './context';
import { Icon } from './icons';
import { SelectorChip } from './selector-chip';
import { SelectorInput } from './selector-input';
import { SelectorStack, stackLevels } from './selector-stack';
import { Kbd } from './shell';

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
  onClear,
  bare = false,
}: {
  level: LevelKind;
  label: string;
  view: LevelView | null;
  error: string | null;
  onClear?: () => void;
  /** Leave out the label row, when the caller shows its own. */
  bare?: boolean;
}) {
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const primary = view?.selectors[view.primary];
  const value = selectorText(primary);
  return (
    <div className="ws-col" data-ws={`level-field-${level}`}>
      {!bare && (
        <div className="ws-row ws-row-between">
          <span className="ws-caps">{label}</span>
          {view && <span className="ws-meta ws-mono-sm ws-ellipsis">{view.label}</span>}
        </div>
      )}
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
              onChoose={() => void actions.send({ kind: 'draft.setPrimary', level, index: i })}
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

export function ExclusionInput({ exclude, title = 'Exclude' }: { exclude: ProtocolCandidate[]; title?: string }) {
  const actions = useActions();
  return (
    <div className="ws-col">
      <span className="ws-caps">{title}</span>
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

/** How the host joins the text parts of one item in a sample. */
export const SAMPLE_PARTS = ' · ';

/** Item samples, numbered, with the text parts of each item separated, and how many more there are. */
export function NumberedSamples({ samples, more, extra, plain = false }: { samples: string[]; more: number; extra?: ReactNode; plain?: boolean }) {
  if (samples.length === 0) return null;
  return (
    <div className={`ws-samples${plain ? ' ws-samples-plain' : ''}`} data-ws="samples">
      {samples.map((text, i) => (
        <span key={i} className="ws-sample ws-row" title={text}>
          <span className="ws-sample-n">{i + 1}</span>
          <span className="ws-ellipsis ws-spacer">
            {(text || '(no text)').split(SAMPLE_PARTS).map((part, j) => (
              <span key={j} className={j === 0 ? 'ws-sample-lead' : 'ws-sample-part'}>
                {part}
              </span>
            ))}
          </span>
        </span>
      ))}
      {(more > 0 || extra) && (
        <span className="ws-meta" data-ws="samples-more">
          {more > 0 && `+ ${more} more`}
          {extra}
        </span>
      )}
    </div>
  );
}

/** Why the list setup has no items, naming the level that matches nothing. */
export function invalidReason(proposal: ProposalView): string | null {
  if ((proposal.proposed.count ?? 0) > 0) return null;
  if (proposal.error) return proposal.error.message;
  if (proposal.within && (proposal.within.count ?? 0) === 0) return 'list parent matches nothing';
  if (proposal.proposed.selectors.length === 0) return 'pick or type the item';
  return 'item matches nothing';
}

/** A collapsed control of the list setup: a header with a one-line summary that opens its body. */
function Collapsible({ title, summary, open, onToggle, testId, children }: { title: string; summary: ReactNode; open: boolean; onToggle: () => void; testId: string; children: ReactNode }) {
  return (
    <div className="ws-col ws-collapsible" data-ws={testId} data-open={open || undefined}>
      <button type="button" className="ws-collapse-head" aria-expanded={open} onClick={onToggle} data-ws={`${testId}-toggle`}>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={10} />
        <span className="ws-spacer">{title}</span>
        <span className="ws-meta ws-mono-sm ws-ellipsis">{summary}</span>
      </button>
      {open && children}
    </div>
  );
}

/** Rows of "Adjust item level": distance, chip, matches in the list parent, the likely item, and folded rows. */
function ItemLadder({ proposal, onPreview }: { proposal: ProposalView; onPreview: (path: Path | null) => void }) {
  const actions = useActions();
  const rows = proposal.itemLadder;
  if (!rows) return <span className="ws-meta">Counting levels…</span>;
  const current = proposal.proposed.path.join('.');
  const fromPick = proposal.origin === 'pick';
  return (
    <div className="ws-col ws-ladder-list" data-ws="item-ladder">
      {rows.map((row) => {
        if (row.sameAs !== null) {
          return (
            <span key={row.distance} className="ws-meta ws-ladder-folded" data-ws="ladder-folded" data-distance={row.distance}>
              <Icon name="eye" size={11} />↑{row.distance} hidden · same elements as ↑{row.sameAs}
            </span>
          );
        }
        const pick = fromPick && row.distance === 0;
        return (
          <button
            key={row.distance}
            type="button"
            className="ws-ladder-row"
            aria-pressed={row.path.join('.') === current}
            disabled={row.count === 0}
            onMouseEnter={() => onPreview(row.path)}
            onMouseLeave={() => onPreview(null)}
            onClick={() => void actions.send({ kind: 'draft.setLevel', level: 'item', by: 'path', path: row.path })}
            data-ws="ladder-row"
            data-distance={row.distance}
            data-likely={row.likely || undefined}
          >
            <span className="ws-ladder-d">{pick ? '0' : `↑${row.distance}`}</span>
            {row.selector ? <SelectorChip candidate={row.selector} level={pick ? 'field' : 'item'} /> : <span className="ws-meta">no selector</span>}
            <span className="ws-spacer ws-meta">{pick ? 'your pick' : `${row.count} in list`}</span>
            {row.likely && <span className="ws-badge ws-tone-accent">likely item</span>}
            {row.path.join('.') === current && <Icon name="check" size={11} />}
          </button>
        );
      })}
      {proposal.within && (
        <span className="ws-meta" data-ws="ladder-parent">
          <Icon name="arrow-left" size={11} />↑{(rows.at(-1)?.distance ?? 0) + 1} is the list parent {proposal.within.label}
        </span>
      )}
    </div>
  );
}

/** Rows of "Adjust list parent": the item container's ancestors with the children like the item. */
function ParentLadder({ proposal, onPreview }: { proposal: ProposalView; onPreview: (path: Path | null) => void }) {
  const actions = useActions();
  const rows = proposal.parentLadder;
  if (!rows) return <span className="ws-meta">Counting levels…</span>;
  if (rows.length === 0) return <span className="ws-meta">Set the item first.</span>;
  const current = proposal.within?.path.join('.');
  return (
    <div className="ws-col ws-ladder-list" data-ws="parent-ladder">
      {rows.map((row) => (
        <button
          key={row.distance}
          type="button"
          className="ws-ladder-row"
          aria-pressed={row.path.join('.') === current}
          onMouseEnter={() => onPreview(row.path)}
          onMouseLeave={() => onPreview(null)}
          onClick={() => void actions.send({ kind: 'draft.setLevel', level: 'within', by: 'path', path: row.path })}
          data-ws="parent-row"
          data-distance={row.distance}
          data-likely={row.likely || undefined}
        >
          <span className="ws-ladder-d">↑{row.distance}</span>
          {row.selector ? <SelectorChip candidate={row.selector} level="list" /> : <span className="ws-meta">no selector</span>}
          <span className="ws-spacer ws-meta">{row.children} like the item</span>
          {row.likely && <span className="ws-badge ws-tone-accent">likely list parent</span>}
        </button>
      ))}
    </div>
  );
}

/** A stack row of the list setup: the level's chip and count; a click turns it into the selector input. */
function StackRow({ level, view, error, open, onOpen, onClose }: { level: LevelKind; view: LevelView | null; error: string | null; open: boolean; onOpen: () => void; onClose: () => void }) {
  const actions = useActions();
  const primary = view?.selectors[view.primary];
  if (open || !primary) {
    return (
      <div className="ws-col ws-stack-edit" data-ws={`setup-row-${level}`} data-editing>
        <div className="ws-row">
          <span className={`ws-stack-label ws-spacer ws-label-${level === 'within' ? 'list' : 'item'}`}>{LEVEL_LABEL[level]}</span>
          {primary && (
            <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={onClose} data-ws={`setup-row-done-${level}`}>
              Done
            </button>
          )}
        </div>
        <LevelField
          level={level}
          label={level === 'within' ? 'List parent' : 'Item'}
          view={view}
          error={error}
          bare
          {...(level === 'within' ? { onClear: () => void actions.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' }) } : {})}
        />
      </div>
    );
  }
  return (
    <button type="button" className="ws-stack-row ws-stack-click" style={level === 'item' ? { paddingLeft: 14 } : undefined} onClick={onOpen} title="Click to type a selector by hand" data-ws={`setup-row-${level}`}>
      <span className={`ws-stack-label ws-label-${level === 'within' ? 'list' : 'item'}`}>{LEVEL_LABEL[level]}</span>
      <SelectorChip candidate={primary} level={level === 'within' ? 'list' : 'item'} />
      <span className="ws-spacer" />
      <span className="ws-stack-count" data-ws="stack-count">
        {view?.count ?? '…'}
      </span>
      <Icon name="pencil-simple" size={11} />
    </button>
  );
}

/** A stack row label in its level color. */
const LEVEL_LABEL = { within: 'list parent', item: 'item' } as const;

/**
 * The list setup, over the active table's content: the list parent, the
 * item, and the pick as a stack whose rows turn into selector inputs, three
 * samples, the exclusions, and the two ladders. Accept and Cancel sit in
 * `ListSetupActions`, fixed above the footer. Opened from a pick, manually,
 * or from Rows > Edit (the edit variant).
 */
export function ListSetup({ proposal, table, pick = null, onPreview }: { proposal: ProposalView; table: string; /** Path of the pick the setup came from. */ pick?: Path | null; onPreview: (path: Path | null) => void }) {
  const actions = useActions();
  const [rows, setRows] = useState<Record<LevelKind, boolean>>({ within: false, item: false });
  const openRow = (level: LevelKind, on: boolean) => setRows({ ...rows, [level]: on });
  const [itemOpen, setItemOpen] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const chosen = proposal.proposed;
  const count = chosen.count ?? 0;
  const edit = proposal.origin === 'edit';
  const invalid = invalidReason(proposal);
  const error = (kind: LevelKind) => (proposal.error?.level === kind ? proposal.error.message : null);
  const likely = proposal.itemLadder?.find((r) => r.path.join('.') === chosen.path.join('.'));
  const up = likely?.distance ?? (pick && chosen.path.length > 0 && chosen.path.every((v, i) => pick[i] === v) ? pick.length - chosen.path.length : null);
  const itemSummary = up !== null && proposal.origin === 'pick' ? `↑${up} from pick` : chosen.label || 'not set';
  const toggleItem = () => {
    if (!itemOpen && !proposal.itemLadder) void actions.send({ kind: 'list.ladder', which: 'item' });
    setItemOpen(!itemOpen);
  };
  const toggleParent = () => {
    if (!parentOpen && !proposal.parentLadder) void actions.send({ kind: 'list.ladder', which: 'parent' });
    setParentOpen(!parentOpen);
  };
  const broken = proposal.fieldPreview.filter((f) => f.matched === 0).length;
  const origin = proposal.origin === 'pick' ? 'from your pick' : proposal.origin === 'manual' ? 'set up by hand' : null;
  return (
    <section className="ws-col ws-setup" data-ws="list-setup" data-origin={proposal.origin}>
      <div className="ws-row ws-setup-head">
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label="Back" onClick={() => void actions.send({ kind: 'draft.cancelItems' })} data-ws="setup-back">
          <Icon name="arrow-left" size={13} />
        </button>
        <span className="ws-title ws-spacer">
          {edit ? 'Edit list' : 'Set up list'} <span className="ws-meta">· {table}</span>
        </span>
        <Kbd>Esc</Kbd>
      </div>
      <div className="ws-row ws-setup-count">
        <span className={`ws-count${invalid ? ' ws-count-zero' : ''}`} data-ws="items-count">
          {chosen.count ?? '…'}
        </span>
        <span className="ws-spacer">items on this page</span>
        {invalid ? (
          <span className="ws-meta ws-invalid-text" data-ws="setup-invalid">
            {invalid}
          </span>
        ) : edit && proposal.previousCount !== null ? (
          <span className="ws-meta" data-ws="items-was">
            was {proposal.previousCount}
          </span>
        ) : (
          <span className="ws-meta">{origin}</span>
        )}
      </div>
      <span className="ws-meta">
        {chosen.total !== null && chosen.total !== chosen.count ? `${chosen.total} before exclusions · ` : ''}
        <span data-ws="items-skipped">{proposal.skipped} skipped as dissimilar</span>
      </span>
      <div className="ws-stack ws-setup-stack" data-ws="setup-stack">
        <StackRow level="within" view={proposal.within} error={error('within')} open={rows.within} onOpen={() => openRow('within', true)} onClose={() => openRow('within', false)} />
        <StackRow level="item" view={chosen.selectors.length > 0 ? chosen : null} error={error('item')} open={rows.item} onOpen={() => openRow('item', true)} onClose={() => openRow('item', false)} />
        {proposal.pick && proposal.pick.selector && (
          <div className="ws-stack-row ws-stack-pick" style={{ paddingLeft: 28 }} data-ws="setup-pick">
            <span className="ws-stack-label ws-label-field">your pick</span>
            <SelectorChip candidate={proposal.pick.selector} level="field" />
            <span className="ws-spacer" />
            <span className="ws-stack-count">
              {proposal.pick.matched}/{proposal.pick.total}
            </span>
          </div>
        )}
      </div>
      <span className="ws-meta">Click a row to type a selector by hand.</span>
      <NumberedSamples samples={chosen.samples} more={Math.max(0, count - chosen.samples.length)} extra={count > 0 ? ' · all highlighted on the page' : undefined} />
      {edit && proposal.fieldPreview.length > 0 && (
        <div className="ws-col ws-danger-box" data-ws="field-preview">
          {broken > 0 && (
            <span className="ws-row ws-title" data-ws="field-preview-broken">
              <Icon name="warning" weight="bold" size={13} />
              {broken} field{broken > 1 ? 's' : ''} would read nothing
            </span>
          )}
          {proposal.fieldPreview.map((f) => (
            <span key={f.name} className="ws-row" data-ws="field-preview-row" data-name={f.name}>
              <span className="ws-mono-sm ws-spacer">{f.name}</span>
              <span className="ws-coverage" data-partial data-zero={f.matched === 0 || undefined}>
                {f.matched}/{f.total}
              </span>
            </span>
          ))}
          <span className="ws-meta">Fields keep their selectors; they run inside the new items.</span>
        </div>
      )}
      <div className="ws-col ws-adjust">
        <Collapsible title="Adjust item level" summary={itemSummary} open={itemOpen} onToggle={toggleItem} testId="adjust-item">
          <ItemLadder proposal={proposal} onPreview={onPreview} />
          <div className="ws-row">
            <span className="ws-meta ws-spacer">Include all siblings</span>
            <Toggle on={proposal.includeAll} onChange={() => void actions.send({ kind: 'draft.toggleIncludeAll' })} label="Include all siblings" testId="include-all" />
          </div>
        </Collapsible>
        <Collapsible title="Adjust list parent" summary={proposal.within?.label ?? 'none'} open={parentOpen} onToggle={toggleParent} testId="adjust-parent">
          <ParentLadder proposal={proposal} onPreview={onPreview} />
        </Collapsible>
      </div>
      <ExclusionInput exclude={proposal.exclude} title="Exclude" />
    </section>
  );
}

/** Accept (Enter) and Cancel (Esc) of the list setup, fixed above the footer. */
export function ListSetupActions({ proposal }: { proposal: ProposalView }) {
  const actions = useActions();
  const count = proposal.proposed.count ?? 0;
  return (
    <div className="ws-setup-bar" data-ws="setup-actions">
      <button type="button" className="ws-btn ws-btn-outline ws-spacer" disabled={count === 0} onClick={() => void actions.send({ kind: 'draft.confirmItems' })} data-ws="confirm-items">
        <Icon name="check" size={12} />
        {proposal.origin === 'edit' ? 'Update list' : `Accept ${count} items`} <Kbd>Enter</Kbd>
      </button>
      <button type="button" className="ws-btn" onClick={() => void actions.send({ kind: 'draft.cancelItems' })} data-ws="cancel-items">
        Cancel <Kbd>Esc</Kbd>
      </button>
    </div>
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

/** Edit, and Remove while the table has no fields, for the confirmed item container, in the Rows section header. */
export function ItemActions({ item, locked }: { item: DraftItem; locked: boolean }) {
  const actions = useActions();
  return (
    <>
      {item.count !== null && item.count > 0 && (
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.editItem' })} data-ws="edit-item">
          <Icon name="pencil-simple" size={12} />
          Edit
        </button>
      )}
      {!locked && (
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.clearItem' })} data-ws="clear-item">
          <Icon name="trash" size={12} />
          Remove
        </button>
      )}
    </>
  );
}
