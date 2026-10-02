import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { tableMode, type Draft, type DraftTable, type TableMode } from '@webscoop/core/page';
import { useActions, useSnapshot } from './context';
import { dropIndex, useDragList } from './drag';
import { Icon, type IconName } from './icons';
import { DescriptionInput } from './recipe';
import { Kbd } from './shell';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a table name cannot be used, or null: it must be kebab-case and unique among the other tables. */
export function tableNameProblem(name: string, tables: readonly DraftTable[], except?: number): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'the table needs a name';
  if (!KEBAB.test(trimmed)) return 'table names must be kebab-case';
  return tables.some((t, i) => i !== except && t.name === trimmed) ? `a table named ${trimmed} already exists` : null;
}

/** Name for a new table: `page` when every table has an item container, else the first free `table-N`. */
export function newTableName(tables: readonly DraftTable[]): string {
  const taken = tables.map((t) => t.name);
  if (tables.every((t) => t.item !== null) && !taken.includes('page')) return 'page';
  for (let n = tables.length + 1; ; n++) if (!taken.includes(`table-${n}`)) return `table-${n}`;
}

const MODE_ICON = { list: 'rows', page: 'rectangle', none: 'circle' } as const;
const MODE_TITLE = { list: 'list', page: 'page table', none: 'no mode yet' } as const;

/** The mode icon of a table: a list, a page table, or neutral while it has no mode. */
export function ModeIcon({ table }: { table: Pick<DraftTable, 'item' | 'fields'> }) {
  const mode = tableMode(table);
  return (
    <span className="ws-mode-icon" title={MODE_TITLE[mode]} data-ws="tab-mode-icon" data-mode={mode}>
      <Icon name={MODE_ICON[mode]} size={12} />
    </span>
  );
}

/** The table header's mode line: "List · N rows", "Page · 1 row", or "No mode yet". */
export function modeLabel(table: DraftTable): string {
  const mode: TableMode = tableMode(table);
  if (mode === 'list') return `List · ${table.item!.count ?? '…'} rows`;
  return mode === 'page' ? 'Page · 1 row' : 'No mode yet';
}

/** Rows the table yields on this page, when known: its container count, or one row for a table without containers. */
export function tableRowCount(table: DraftTable): number | null {
  if (table.item) return table.item.count;
  return table.fields.length > 0 ? 1 : null;
}

/** The table the runner paginates with: the first table with an item container, or -1. */
export function primaryTable(tables: readonly DraftTable[]): number {
  return tables.findIndex((t) => t.item !== null);
}

/** Whether the draft paginates, so its driving table drives it. */
export const paginates = (draft: Draft): boolean => Boolean(draft.pagination);

/** Index of the table that drives the paginate block: its `table`, else the first item table extracted in its `do`; -1 without pagination. */
export function drivingTableIndex(draft: Pick<Draft, 'tables' | 'pagination' | 'sequence'>): number {
  if (!draft.pagination) return -1;
  if (draft.pagination.table) return draft.tables.findIndex((t) => t.name === draft.pagination!.table);
  const block = draft.sequence.blocks.find((b) => 'paginate' in b);
  const inner = block && 'paginate' in block ? block.paginate.do : [];
  for (const b of inner) {
    if (!('extract' in b)) continue;
    const index = draft.tables.findIndex((t) => t.name === b.extract && t.item !== null);
    if (index >= 0) return index;
  }
  return -1;
}

/** Indexes of the tabs not fully visible in the strip, from their horizontal extents. */
export function clippedTabs(strip: { left: number; right: number }, tabs: readonly { left: number; right: number }[]): number[] {
  return tabs.flatMap((t, i) => (t.left < strip.left - 0.5 || t.right > strip.right + 0.5 ? [i] : []));
}

/** The tab's inline rename box: Enter or blur commits, Esc cancels; a refused name keeps the box open with the error. */
function RenameInput({ table, index, tables, onDone }: { table: DraftTable; index: number; tables: readonly DraftTable[]; onDone: (problem: string | null) => void }) {
  const actions = useActions();
  const [value, setValue] = useState(table.name);
  const [problem, setProblem] = useState<string | null>(null);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    const name = value.trim();
    if (name === table.name) {
      done.current = true;
      return onDone(null);
    }
    const refused = tableNameProblem(name, tables, index);
    setProblem(refused);
    if (refused) return onDone(refused);
    done.current = true;
    void actions.send({ kind: 'draft.renameTable', name });
    onDone(null);
  };
  return (
    <input
      className={`ws-input ws-input-sm ws-mono-sm ws-tab-rename${problem ? ' ws-invalid' : ''}`}
      value={value}
      autoFocus
      aria-label="Table name"
      aria-invalid={problem ? true : undefined}
      data-ws="tab-rename"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          done.current = true;
          onDone(null);
        }
      }}
    />
  );
}

/**
 * One tab per table in recipe order, with its kind icon, name, row count,
 * and error dot, and a pinned `+` tab. Tabs activate, rename (double-click
 * or F2), reorder (drag or Alt+Left and Alt+Right), and scroll when they do
 * not fit, with a "N more" menu of the hidden ones.
 */
export function TabBar({ draft, locked }: { draft: Draft; locked: boolean }) {
  const actions = useActions();
  const { ui } = useSnapshot();
  const strip = useRef<HTMLDivElement>(null);
  const drag = useDragList({ list: 'tabs', axis: 'x', onMove: (from, slot) => move(from.index, dropIndex(from.index, slot.index)) });
  const [hidden, setHidden] = useState<number[]>([]);
  const [renameError, setRenameError] = useState<string | null>(null);
  const primary = drivingTableIndex(draft);
  const badge = paginates(draft);
  const order = draft.tables.map((t) => t.name).join('\u0000');

  // Keep keyboard focus on the moved tab.
  useLayoutEffect(() => {
    if (ui.focusedTab === null) return;
    const tab = strip.current?.querySelectorAll<HTMLElement>('[data-ws="tab"]')[ui.focusedTab];
    if (tab && tab.ownerDocument.activeElement !== tab && !tab.contains(tab.ownerDocument.activeElement)) tab.focus();
  }, [order, ui.focusedTab]);

  // Count the tabs the strip clips.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const tabs = Array.from(el.querySelectorAll<HTMLElement>('[data-ws="tab"]')).map((t) => t.getBoundingClientRect());
      const next = clippedTabs(el.getBoundingClientRect(), tabs);
      setHidden((prev) => (prev.join() === next.join() ? prev : next));
    };
    measure();
    const RO = (el.ownerDocument.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
    if (!RO) return;
    const observer = new RO(measure);
    observer.observe(el);
    el.addEventListener('scroll', measure);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [order]);

  const activate = (index: number) => {
    if (index !== draft.activeTable) void actions.send({ kind: 'draft.selectTable', index });
  };
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= draft.tables.length) return;
    void actions.send({ kind: 'draft.moveTable', from, to });
  };
  const moreOpen = ui.menu === 'tabs-more';

  return (
    <div className="ws-col">
      <div className="ws-tabbar">
        <div className="ws-tabs" ref={strip} {...drag.containerProps} role="tablist" aria-label="Tables" data-ws="tabs">
          {draft.tables.map((table, index) => {
            const active = index === draft.activeTable;
            const count = tableRowCount(table);
            const renaming = ui.renamingTab === index && active;
            const title = table.error ?? table.fields.find((f) => f.error)?.error ?? (locked && !active ? 'Finish the list setup first' : undefined);
            if (renaming) {
              return (
                <div key={table.name} className="ws-tab" role="tab" aria-selected data-ws="tab" data-table={table.name} data-active>
                  <ModeIcon table={table} />
                  <RenameInput
                    table={table}
                    index={index}
                    tables={draft.tables}
                    onDone={(problem) => {
                      setRenameError(problem);
                      if (!problem) actions.setUi({ renamingTab: null });
                    }}
                  />
                </div>
              );
            }
            const tab = drag.row(index);
            return (
              <button
                key={table.name}
                type="button"
                role="tab"
                aria-selected={active}
                className={`ws-tab${tab.state.dragging ? ' ws-tab-dragging' : ''}${tab.state.lineBefore ? ' ws-tab-drop' : ''}${tab.state.lineAfter ? ' ws-tab-drop ws-tab-drop-end' : ''}`}
                disabled={locked && !active}
                title={title}
                draggable={!locked}
                onClick={() => activate(index)}
                onDoubleClick={() => {
                  if (locked) return;
                  activate(index);
                  actions.setUi({ renamingTab: index });
                }}
                onFocus={() => actions.setUi({ focusedTab: index, focusedField: null, focusedStep: null })}
                onBlur={(e) => {
                  if (e.relatedTarget) actions.setUi({ focusedTab: null });
                }}
                {...(locked ? {} : tab.props)}
                data-ws="tab"
                data-table={table.name}
                data-active={active || undefined}
              >
                <ModeIcon table={table} />
                <span className="ws-tab-name">{table.name}</span>
                {count !== null && (
                  <span className="ws-tab-count" data-ws="tab-count">
                    {count}
                  </span>
                )}
                {badge && index === primary && (
                  <span className="ws-tab-badge" title="The runner follows pagination with this table" data-ws="tab-drives-pagination">
                    pages
                  </span>
                )}
                {(table.error || table.fields.some((f) => f.error)) && <span className="ws-tab-dot" data-ws="tab-error" aria-label="has an error" />}
              </button>
            );
          })}
        </div>
        {hidden.length > 0 && (
          <span className="ws-menu-anchor">
            <button
              type="button"
              className="ws-tab ws-tab-more"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => actions.setUi({ menu: moreOpen ? null : 'tabs-more' })}
              data-ws="tabs-more"
            >
              {hidden.length} more
              <Icon name="caret-down" size={9} />
            </button>
            {moreOpen && (
              <div className="ws-menu" role="menu" style={{ right: 0, top: 30 }} data-ws="tabs-more-menu">
                {hidden.map((i) => (
                  <button
                    key={draft.tables[i]!.name}
                    type="button"
                    role="menuitem"
                    className="ws-menu-item"
                    disabled={locked}
                    onClick={() => {
                      actions.setUi({ menu: null });
                      activate(i);
                      strip.current?.querySelectorAll<HTMLElement>('[data-ws="tab"]')[i]?.scrollIntoView?.({ inline: 'nearest' });
                    }}
                    data-ws="tabs-more-item"
                    data-table={draft.tables[i]!.name}
                  >
                    <ModeIcon table={draft.tables[i]!} />
                    {draft.tables[i]!.name}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        <button
          type="button"
          className="ws-tab ws-tab-add"
          disabled={locked}
          aria-label="Add a table"
          title="Add a table: picks go to the active table"
          onClick={() => void actions.send({ kind: 'draft.addTable' })}
          onDragOver={(e) => e.preventDefault()}
          data-ws="tab-add"
        >
          <Icon name="plus" size={12} />
        </button>
      </div>
      {renameError && ui.renamingTab !== null && (
        <span className="ws-error" data-ws="tab-rename-error">
          {renameError}
        </span>
      )}
    </div>
  );
}

/** The active table's "…" menu: the mode lock, Rename, Move left, Move right, Use for pagination, Clear table, Remove table. */
export function TableMenu({ draft, locked }: { draft: Draft; locked: boolean }) {
  const actions = useActions();
  const { ui } = useSnapshot();
  const open = ui.menu === 'table';
  const at = draft.activeTable;
  const table = draft.tables[at]!;
  const primary = drivingTableIndex(draft);
  const close = () => actions.setUi({ menu: null });
  const item = (label: string, ws: string, onClick: () => void, disabled = false, title?: string, danger = false, icon?: IconName, hint?: ReactNode) => (
    <button
      type="button"
      role="menuitem"
      className={`ws-menu-item${danger ? ' ws-menu-danger' : ''}`}
      disabled={disabled}
      title={title}
      onClick={() => {
        close();
        onClick();
      }}
      data-ws={ws}
    >
      {icon && <Icon name={icon} size={12} />}
      <span className="ws-spacer">{label}</span>
      {hint && <span className="ws-menu-hint">{hint}</span>}
    </button>
  );
  const mode = tableMode(table);
  const pagingTitle = !table.item ? 'Only a table with an item container can drive pagination' : primary === at ? 'This table already drives pagination' : !draft.pagination ? 'Mark a pagination target first' : 'Make this table drive the paginate block';
  return (
    <span className="ws-menu-anchor">
      <button
        type="button"
        className="ws-btn ws-btn-ghost ws-btn-sm"
        aria-label={`Table ${table.name} menu`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={locked}
        onClick={() => actions.setUi({ menu: open ? null : 'table' })}
        data-ws="table-menu"
      >
        <Icon name="dots-three" size={14} />
      </button>
      {open && (
        <div className="ws-menu" role="menu" style={{ right: 0, top: 24 }} data-ws="table-menu-list">
          {table.fields.length > 0 && (
            <div className="ws-menu-note" role="note" data-ws="table-menu-locked">
              <Icon name="lock-simple" size={11} />
              Mode locked — {mode}. Clear table to change.
            </div>
          )}
          {item('Rename', 'table-menu-rename', () => actions.setUi({ renamingTab: at }), false, undefined, false, 'pencil-simple', 'dbl-click tab')}
          {item('Move left', 'table-menu-move-left', () => void actions.send({ kind: 'draft.moveTable', from: at, to: at - 1 }), at === 0, undefined, false, 'arrow-left', <Kbd>Alt ←</Kbd>)}
          {item('Move right', 'table-menu-move-right', () => void actions.send({ kind: 'draft.moveTable', from: at, to: at + 1 }), at === draft.tables.length - 1, undefined, false, 'arrow-right', <Kbd>Alt →</Kbd>)}
          {item(
            'Use for pagination',
            'table-menu-pagination',
            () => void actions.send({ kind: 'paginate.update', patch: { table: table.name } }),
            !table.item || primary === at || !draft.pagination,
            pagingTitle,
            false,
            'arrow-right',
            !table.item ? 'list tables only' : primary === at ? 'already drives it' : undefined,
          )}
          {(table.fields.length > 0 || table.item) && <div className="ws-menu-sep" />}
          {(table.fields.length > 0 || table.item) &&
            item(
              'Clear table',
              'table-menu-clear-table',
              () => void actions.send({ kind: 'draft.clearTable' }),
              false,
              table.item ? 'Remove the fields and the list; the table keeps its name' : 'Remove the fields; the table keeps its name',
              false,
              'eraser',
              table.item && table.fields.length > 0 ? 'fields + list' : table.item ? 'list' : 'fields',
            )}
          {draft.tables.length > 1 && item('Remove table', 'table-menu-remove', () => void actions.send({ kind: 'draft.removeTable' }), false, 'Remove this table with its item container and fields', true, 'trash')}
        </div>
      )}
    </span>
  );
}

/** The active table's name, its mode (a list with its row count, a page table, or no mode yet), and its menu, with its validation error. */
export function TableHeader({ draft, locked }: { draft: Draft; locked: boolean }) {
  const table = draft.tables[draft.activeTable]!;
  return (
    <div className="ws-col" data-ws="table-header">
      <div className="ws-table-head">
        <span className="ws-title ws-mono ws-ellipsis" data-ws="table-name">
          {table.name}
        </span>
        <span className="ws-table-kind ws-kind-pill" data-ws="table-kind" data-kind={tableMode(table)}>
          <ModeIcon table={table} />
          {modeLabel(table)}
        </span>
        {drivingTableIndex(draft) === draft.activeTable && (
          <span className="ws-badge ws-tone-accent" title="This table drives the paginate block" data-ws="table-pages-badge">
            pages
          </span>
        )}
        <span className="ws-spacer" />
        <TableMenu draft={draft} locked={locked} />
      </div>
      {table.error && table.fields.length > 0 && (
        <span className="ws-error" data-ws="table-error">
          {table.error}
        </span>
      )}
    </div>
  );
}

/** The active table's description, directly under the tab bar. */
export function TableDescription({ draft, error }: { draft: Draft; error: { key: string; message: string } | null }) {
  const index = draft.activeTable;
  const table = draft.tables[index]!;
  return (
    <div className="ws-table-description" data-ws="table-description-row">
      <DescriptionInput
        key={index}
        value={table.description}
        target={{ kind: 'table', index }}
        label={`Description of table ${table.name}`}
        testId="table-description"
        error={error?.key === `table:${index}` ? error.message : null}
      />
    </div>
  );
}
