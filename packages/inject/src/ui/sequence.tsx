import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { STOP_RULES, type BlockPath, type Draft, type DraftBlock, type DraftInnerBlock, type DraftPagination, type PaginationPatch, type SequenceError } from '@webscoop/core/page';
import { useActions, useSnapshot } from './context';
import { dropIndex, lineClass, rowHeader, useDragList, type DragRowState } from './drag';
import { Segmented } from './flows';
import { Icon } from './icons';
import { Toggle } from './items';
import { Section } from './section';
import { TargetEditor } from './target-editor';

const STOP_LABELS: Record<(typeof STOP_RULES)[number], string> = {
  'no-new-items': 'no new items',
  'first-item-repeats': 'first item repeats',
  'target-missing': 'target disabled or missing',
};

const samePath = (a: readonly number[] | null | undefined, b: readonly number[]) => !!a && a.length === b.length && a.every((v, i) => b[i] === v);

/** A block as short text: `flow name`, `extract table`, or `paginate kind`. */
export function blockText(block: DraftBlock | DraftInnerBlock, pagination: DraftPagination | null): string {
  if ('flow' in block) return `flow: ${block.flow}`;
  if ('extract' in block) return `extract: ${block.extract}`;
  return `paginate: ${pagination?.kind ?? '…'}`;
}

/** The collapsed Sequence summary: the blocks in short form. */
export function sequenceSummary(draft: Pick<Draft, 'sequence' | 'pagination'>): string {
  const blocks = draft.sequence.blocks;
  if (blocks.length === 0) return 'empty';
  return blocks.map((b) => ('paginate' in b ? `paginate ${draft.pagination?.kind ?? ''} [${b.paginate.do.map((d) => blockText(d, null)).join(', ')}]` : blockText(b, null))).join(' → ');
}

/** "Fix N sequence errors to save", or null without errors. */
export function sequenceBlocker(draft: Pick<Draft, 'sequenceErrors'>): string | null {
  const n = draft.sequenceErrors.length;
  return n === 0 ? null : `Fix ${n} sequence error${n === 1 ? '' : 's'} to save`;
}

/** The paginate block's settings: kind, target, limit, stop rules, and the driving table. */
function PaginateSettings({ draft, pagination }: { draft: Draft; pagination: DraftPagination }) {
  const actions = useActions();
  const snap = useSnapshot();
  const update = (patch: PaginationPatch) => void actions.send({ kind: 'paginate.update', patch });
  const [pages, setPages] = useState(typeof pagination.limit === 'number' && pagination.limit > 1 ? pagination.limit : 3);
  const limit = pagination.limit === 'all' ? 'all' : pagination.limit === 1 ? 'one' : 'n';
  const itemTables = draft.tables.filter((t) => t.item !== null).map((t) => t.name);
  return (
    <div className="ws-col ws-paginate-settings" data-ws="paginate-settings">
      <div className="ws-edit-line">
        <span className="ws-edit-label">kind</span>
        <Segmented
          label="Pagination kind"
          testId="paginate-kind"
          value={pagination.kind}
          onChange={(kind) => update({ kind })}
          options={[
            { value: 'url', label: 'url' },
            { value: 'next', label: 'next' },
            { value: 'more', label: 'more' },
            { value: 'scroll', label: 'scroll' },
          ]}
        />
      </div>
      <div className="ws-edit-line">
        <span className="ws-edit-label">target</span>
        <span className="ws-row ws-spacer" data-ws="paginate-target">
          {pagination.target ? <TargetEditor targetRef={{ kind: 'pagination' }} target={pagination.target} edit={snap.host?.targetEdit ?? null} testId="paginate-target-edit" /> : <span className="ws-meta">{pagination.kind === 'scroll' ? 'none: the page loads more while scrolling' : 'none: pick a next link or load more button'}</span>}
        </span>
      </div>
      {pagination.kind === 'url' && pagination.param && (
        <div className="ws-edit-line">
          <span className="ws-edit-label">param</span>
          <span className="ws-meta" data-ws="paginate-param">
            <span className="ws-mono-sm">{pagination.param.name}</span> from {pagination.param.start}, step {pagination.param.step}
          </span>
        </div>
      )}
      <div className="ws-edit-line">
        <span className="ws-edit-label">limit</span>
        <Segmented
          label="Page limit"
          testId="paginate-limit"
          value={limit}
          onChange={(value) => update({ limit: value === 'one' ? 1 : value === 'all' ? 'all' : pages })}
          options={[
            { value: 'one', label: '1 page' },
            { value: 'n', label: 'first N' },
            { value: 'all', label: 'all' },
          ]}
        />
        {limit === 'n' && (
          <input
            className="ws-input ws-input-sm ws-mono-sm ws-input-num"
            inputMode="numeric"
            aria-label="Pages"
            value={pages}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= 2) {
                setPages(n);
                update({ limit: n });
              }
            }}
            data-ws="paginate-pages"
          />
        )}
      </div>
      <div className="ws-edit-line">
        <span className="ws-edit-label">stop</span>
        <div className="ws-col ws-spacer">
          {STOP_RULES.map((rule) => {
            const on = pagination.stopRules.includes(rule);
            return (
              <span key={rule} className="ws-row">
                <Toggle on={on} label={STOP_LABELS[rule]} testId={`paginate-stop-${rule}`} onChange={(next) => update({ stopRules: next ? [...pagination.stopRules, rule] : pagination.stopRules.filter((r) => r !== rule) })} />
                <span className="ws-meta">{STOP_LABELS[rule]}</span>
              </span>
            );
          })}
        </div>
      </div>
      <div className="ws-edit-line">
        <span className="ws-edit-label">drives</span>
        <select className="ws-select" aria-label="Driving table" value={pagination.table ?? ''} onChange={(e) => update({ table: e.target.value === '' ? null : e.target.value })} data-ws="paginate-table">
          <option value="">first item table</option>
          {itemTables.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="ws-row">
        <span className="ws-spacer" />
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.clearPagination' })} data-ws="paginate-remove">
          Remove pagination
        </button>
      </div>
    </div>
  );
}

/** What a block shows after its kind: a flow's step count, a table's mode. */
function blockDetail(draft: Draft, block: DraftBlock | DraftInnerBlock): string | null {
  if ('flow' in block) {
    const flow = draft.flows.find((f) => f.name === block.flow);
    if (!flow) return null;
    return `${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}`;
  }
  if ('extract' in block) {
    const table = draft.tables.find((t) => t.name === block.extract);
    if (!table) return null;
    if (table.item) return table.item.count !== null ? `${table.item.count} rows / page` : 'list';
    return '1 row';
  }
  return null;
}

function BlockRow({
  draft,
  block,
  path,
  number,
  errors,
  focused,
  children,
  drag,
}: {
  draft: Draft;
  block: DraftBlock | DraftInnerBlock;
  path: BlockPath;
  number: string;
  errors: SequenceError[];
  focused: boolean;
  children?: ReactNode;
  drag: { props: HTMLAttributes<HTMLDivElement>; state: DragRowState };
}) {
  const snap = useSnapshot();
  const actions = useActions();
  const kind = 'flow' in block ? 'flow' : 'extract' in block ? 'extract' : 'paginate';
  const name = 'flow' in block ? block.flow : 'extract' in block ? block.extract : (draft.pagination?.kind ?? '');
  const own = errors.filter((e) => samePath(e.path, path));
  const detail = blockDetail(draft, block);
  const open = snap.ui.paginateOpen;
  return (
    <div
      {...drag.props}
      className={`ws-block${own.length > 0 ? ' ws-block-error' : ''}${kind === 'paginate' ? ' ws-block-paginate' : ''}${focused ? ' ws-field-focused' : ''}${drag.state.dragging ? ' ws-block-dragging' : ''}${lineClass(drag.state)}`}
      data-ws="block"
      data-kind={kind}
      data-path={path.join('.')}
      tabIndex={-1}
      draggable
      onFocus={(e) => {
        if (e.target === e.currentTarget) actions.setUi({ focusedBlock: path, focusedStep: null, focusedField: null, focusedTab: null });
      }}
      onClick={(e) => {
        e.stopPropagation();
        actions.setUi({ focusedBlock: path, focusedStep: null, focusedField: null, focusedTab: null });
      }}
    >
      <div className="ws-row">
        <span className="ws-handle" aria-hidden="true" title="Drag to reorder (Alt+Up, Alt+Down)">
          <Icon name="dots-six-vertical" size={12} />
        </span>
        <span className="ws-num" aria-hidden="true">
          {number}
        </span>
        <Icon name={kind === 'flow' ? 'flow-arrow' : kind === 'extract' ? 'rows' : 'arrow-right'} size={11} />
        <span className="ws-meta">{kind}</span>
        <span className="ws-mono ws-ellipsis" data-ws="block-name">
          {name}
        </span>
        {detail && <span className="ws-meta ws-ellipsis">{detail}</span>}
        {own.length > 0 && (
          <span className="ws-error ws-ellipsis" data-ws="block-error" title={own.map((e) => e.message).join('\n')}>
            {own[0]!.message}
          </span>
        )}
        <span className="ws-spacer" />
        {kind === 'paginate' && (
          <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={open ? 'Hide pagination settings' : 'Show pagination settings'} aria-expanded={open} onClick={() => actions.setUi({ paginateOpen: !open })} data-ws="paginate-toggle">
            <Icon name={open ? 'caret-down' : 'pencil-simple'} size={11} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** The Sequence section: numbered blocks, the paginate block with its settings and nested blocks, errors, and reset. */
export function SequenceSection({ draft, collapsed, onCollapse }: { draft: Draft; collapsed: boolean; onCollapse: (collapsed: boolean) => void }) {
  const snap = useSnapshot();
  const actions = useActions();
  const { blocks, custom } = draft.sequence;
  const errors = draft.sequenceErrors;
  const p = blocks.findIndex((b) => 'paginate' in b);
  const blockPath = (container: string, index: number): BlockPath => (container === 'do' ? [p, index] : [index]);
  const drag = useDragList({
    list: 'sequence',
    axis: 'y',
    getImage: rowHeader,
    // The paginate block cannot move into itself.
    accepts: (from, slot) => !(slot.container === 'do' && from.container === 'top' && from.index === p),
    onMove: (from, slot) => {
      const to = from.container === slot.container ? dropIndex(from.index, slot.index) : slot.index;
      void actions.send({ kind: 'sequence.move', from: blockPath(from.container, from.index), to: blockPath(slot.container, to) });
    },
  });
  const focused = snap.ui.focusedBlock;
  const headActions = (
    <>
      {errors.length > 0 && (
        <span className="ws-error" data-ws="sequence-error-count">
          {errors.length} error{errors.length === 1 ? '' : 's'}
        </span>
      )}
      {custom ? (
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'sequence.reset' })} data-ws="sequence-reset">
          Reset to default
        </button>
      ) : (
        <span className="ws-tag" title="Follows the flows and tables until you edit it" data-ws="sequence-default">
          default
        </span>
      )}
    </>
  );
  return (
    <Section
      id="sequence"
      title="Sequence"
      count={blocks.length > 0 ? blocks.length : null}
      actions={headActions}
      collapsible
      collapsed={collapsed}
      onCollapse={onCollapse}
      summary={
        <span data-ws="sequence-summary" data-error={errors.length > 0 || undefined}>
          {errors.length > 0 && <Icon name="warning" size={10} />} {sequenceSummary(draft)}
        </span>
      }
    >
      <div className="ws-col" data-ws="sequence" {...drag.containerProps}>
        {blocks.length === 0 && <span className="ws-meta">Nothing runs yet. Add a table or record a flow.</span>}
        {blocks.map((block, i) => {
          const path: BlockPath = [i];
          if (!('paginate' in block)) {
            return <BlockRow key={i} draft={draft} block={block} path={path} number={String(i + 1)} errors={errors} focused={samePath(focused, path)} drag={drag.row(i, 'top')} />;
          }
          const empty = drag.slot(0, 'do');
          return (
            <BlockRow key={i} draft={draft} block={block} path={path} number={String(i + 1)} errors={errors} focused={samePath(focused, path)} drag={drag.row(i, 'top')}>
              {snap.ui.paginateOpen && draft.pagination && <PaginateSettings draft={draft} pagination={draft.pagination} />}
              <div
                className="ws-col ws-paginate-do"
                data-ws="paginate-do"
              >
                {block.paginate.do.map((inner, j) => {
                  const innerPath: BlockPath = [i, j];
                  return <BlockRow key={j} draft={draft} block={inner} path={innerPath} number={`${i + 1}.${j + 1}`} errors={errors} focused={samePath(focused, innerPath)} drag={drag.row(j, 'do')} />;
                })}
                {block.paginate.do.length === 0 && <div {...empty.props} className={`ws-paginate-empty${empty.line ? ' ws-drop-before' : ''}`} data-ws="paginate-empty" />}
                <span className="ws-meta">repeats on every page</span>
              </div>
            </BlockRow>
          );
        })}
        {errors.filter((e) => e.path === null).map((e, i) => (
          <span key={i} className="ws-error" data-ws="sequence-error">
            {e.message}
          </span>
        ))}
        {errors.length > 0 && (
          <div className="ws-col ws-error-list" data-ws="sequence-errors">
            {errors.map((e, i) => (
              <span key={i} className="ws-error">
                {e.path ? `${e.path.map((n) => n + 1).join('.')}: ` : ''}
                {e.message}
              </span>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}
