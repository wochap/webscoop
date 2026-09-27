import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Draft, DraftTable } from '@webscoop/core/page';
import { useActions, useSnapshot } from './context';
import { Icon } from './icons';

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

/** Rows the table yields on this page, when known: its container count, or one row for a table without containers. */
export function tableRowCount(table: DraftTable): number | null {
  if (table.item) return table.item.count;
  return table.fields.length > 0 ? 1 : null;
}

/** The table the runner paginates with: the first table with an item container, or -1. */
export function primaryTable(tables: readonly DraftTable[]): number {
  return tables.findIndex((t) => t.item !== null);
}

/** Whether the draft paginates, so the primary table drives it. */
export const paginates = (draft: Draft): boolean => Boolean(draft.pagination && draft.pagination.kind !== 'none');

/** Where a tab dropped before tab `before` (or at the end, `before` = length) lands, as a `moveTable` target index. */
export function dropIndex(from: number, before: number): number {
  return from < before ? before - 1 : before;
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
      data-ws="table-name"
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
  const [dragging, setDragging] = useState<number | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [hidden, setHidden] = useState<number[]>([]);
  const [renameError, setRenameError] = useState<string | null>(null);
  const primary = primaryTable(draft.tables);
  const primaryName = primary === -1 ? null : draft.tables[primary]!.name;
  const badge = paginates(draft);
  const order = draft.tables.map((t) => t.name).join('\u0000');
  const last = useRef({ order, primaryName });

  // A reorder (same tables, another order) that changes the primary table is announced; no undo.
  useEffect(() => {
    const prev = last.current;
    last.current = { order, primaryName };
    const reordered = prev.order !== order && prev.order.split('\u0000').sort().join() === order.split('\u0000').sort().join();
    if (reordered && badge && primaryName && prev.primaryName !== primaryName) actions.toast('neutral', `${primaryName} now drives pagination`);
  }, [order, primaryName, badge, actions]);

  // Keep keyboard focus on the moved tab.
  useLayoutEffect(() => {
    if (ui.focusedTab === null) return;
    const tab = strip.current?.querySelectorAll<HTMLElement>('[data-ws="table-tab"]')[ui.focusedTab];
    if (tab && tab.ownerDocument.activeElement !== tab && !tab.contains(tab.ownerDocument.activeElement)) tab.focus();
  }, [order, ui.focusedTab]);

  // Count the tabs the strip clips.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const tabs = Array.from(el.querySelectorAll<HTMLElement>('[data-ws="table-tab"]')).map((t) => t.getBoundingClientRect());
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
    <div className="ws-col" data-ws="tabbar">
      <div className="ws-tabbar">
        <div className="ws-tabs" ref={strip} role="tablist" aria-label="Tables" data-ws="tables">
          {draft.tables.map((table, index) => {
            const active = index === draft.activeTable;
            const count = tableRowCount(table);
            const renaming = ui.renamingTab === index && active;
            const title = table.error ?? table.fields.find((f) => f.error)?.error ?? (locked && !active ? 'Finish editing the items first' : undefined);
            if (renaming) {
              return (
                <div key={table.name} className="ws-tab" role="tab" aria-selected data-ws="table-tab" data-table={table.name} data-active>
                  <Icon name={table.item ? 'rows' : 'rectangle'} size={12} />
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
            return (
              <button
                key={table.name}
                type="button"
                role="tab"
                aria-selected={active}
                className={`ws-tab${dragging === index ? ' ws-tab-dragging' : ''}${drop === index ? ' ws-tab-drop' : ''}${drop === draft.tables.length && index === draft.tables.length - 1 ? ' ws-tab-drop ws-tab-drop-end' : ''}`}
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
                onDragStart={(e) => {
                  setDragging(index);
                  e.dataTransfer?.setData('text/plain', String(index));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = rect.width > 0 && e.clientX > rect.left + rect.width / 2;
                  setDrop(after ? index + 1 : index);
                }}
                onDragLeave={() => setDrop(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragging ?? Number(e.dataTransfer?.getData('text/plain'));
                  const before = drop ?? index;
                  setDragging(null);
                  setDrop(null);
                  if (Number.isInteger(from)) move(from, dropIndex(from, before));
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDrop(null);
                }}
                data-ws="table-tab"
                data-table={table.name}
                data-active={active || undefined}
              >
                <Icon name={table.item ? 'rows' : 'rectangle'} size={12} title={table.item ? 'list' : 'page'} />
                <span className="ws-tab-name">{table.name}</span>
                {count !== null && (
                  <span className="ws-tab-count" data-ws="table-count">
                    {count}
                  </span>
                )}
                {badge && index === primary && (
                  <span className="ws-tab-badge" title="The runner follows pagination with this table" data-ws="drives-pagination">
                    pages
                  </span>
                )}
                {(table.error || table.fields.some((f) => f.error)) && <span className="ws-tab-dot" data-ws="table-error" aria-label="has an error" />}
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
                      strip.current?.querySelectorAll<HTMLElement>('[data-ws="table-tab"]')[i]?.scrollIntoView?.({ inline: 'nearest' });
                    }}
                    data-ws="tabs-more-item"
                    data-table={draft.tables[i]!.name}
                  >
                    <Icon name={draft.tables[i]!.item ? 'rows' : 'rectangle'} size={12} />
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
          data-ws="table-add"
        >
          <Icon name="plus" size={12} />
        </button>
      </div>
      {renameError && ui.renamingTab !== null && (
        <span className="ws-error" data-ws="table-name-error">
          {renameError}
        </span>
      )}
    </div>
  );
}

/** The active table's "…" menu: Rename, Move left, Move right, Use for pagination, Remove table. */
export function TableMenu({ draft, locked }: { draft: Draft; locked: boolean }) {
  const actions = useActions();
  const { ui } = useSnapshot();
  const open = ui.menu === 'table';
  const at = draft.activeTable;
  const table = draft.tables[at]!;
  const primary = primaryTable(draft.tables);
  const close = () => actions.setUi({ menu: null });
  const item = (label: string, ws: string, onClick: () => void, disabled = false, title?: string, danger = false) => (
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
      {label}
    </button>
  );
  const pagingTitle = !table.item ? 'Only a table with an item container can drive pagination' : primary === at ? 'This table already drives pagination' : 'Move this table in front of the other lists';
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
        data-ws="tab-menu"
      >
        <Icon name="dots-three" size={14} />
      </button>
      {open && (
        <div className="ws-menu" role="menu" style={{ right: 0, top: 24 }} data-ws="tab-menu-list">
          {item('Rename', 'menu-rename', () => actions.setUi({ renamingTab: at }))}
          {item('Move left', 'menu-move-left', () => void actions.send({ kind: 'draft.moveTable', from: at, to: at - 1 }), at === 0)}
          {item('Move right', 'menu-move-right', () => void actions.send({ kind: 'draft.moveTable', from: at, to: at + 1 }), at === draft.tables.length - 1)}
          {item(
            'Use for pagination',
            'menu-pagination',
            () => void actions.send({ kind: 'draft.moveTable', from: at, to: primary }),
            !table.item || primary === at || primary === -1,
            pagingTitle,
          )}
          {draft.tables.length > 1 && item('Remove table', 'table-remove', () => void actions.send({ kind: 'draft.removeTable' }), false, 'Remove this table with its item container and fields', true)}
        </div>
      )}
    </span>
  );
}

/** The active table's name, its kind (a list with its row count, or a page table), and its menu, with its validation error. */
export function TableHeader({ draft, locked }: { draft: Draft; locked: boolean }) {
  const table = draft.tables[draft.activeTable]!;
  return (
    <div className="ws-col" data-ws="table-header">
      <div className="ws-table-head">
        <span className="ws-title ws-mono ws-ellipsis" data-ws="table-title">
          {table.name}
        </span>
        <span className="ws-table-kind" data-ws="table-kind" data-kind={table.item ? 'list' : 'page'}>
          <Icon name={table.item ? 'rows' : 'rectangle'} size={12} />
          {table.item ? `list · ${table.item.count ?? '…'} rows` : 'page table · one row'}
        </span>
        <span className="ws-spacer" />
        <TableMenu draft={draft} locked={locked} />
      </div>
      {table.error && table.fields.length > 0 && (
        <span className="ws-error" data-ws="table-bar-error">
          {table.error}
        </span>
      )}
    </div>
  );
}
