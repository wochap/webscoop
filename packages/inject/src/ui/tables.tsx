import { useEffect, useState } from 'react';
import type { Draft, DraftTable } from '@webscoop/core/page';
import { useActions } from './context';

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

/** One tab per table with its name and row count; the active one is marked. Tabs activate their table. */
export function TableStrip({ draft, locked }: { draft: Draft; locked: boolean }) {
  const actions = useActions();
  return (
    <section className="ws-row ws-wrap" data-ws="tables" role="tablist" aria-label="Tables">
      {draft.tables.map((table, index) => {
        const active = index === draft.activeTable;
        const count = tableRowCount(table);
        return (
          <button
            key={`${index}-${table.name}`}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ws-btn ws-btn-sm${active ? '' : ' ws-btn-ghost'}${table.error ? ' ws-invalid' : ''}`}
            disabled={locked && !active}
            title={table.error ?? (locked && !active ? 'Finish editing the items first' : undefined)}
            onClick={() => !active && void actions.send({ kind: 'draft.selectTable', index })}
            data-ws="table-tab"
            data-table={table.name}
            data-active={active || undefined}
          >
            <span className="ws-mono-sm">{table.name}</span>
            {count !== null && (
              <span className="ws-num" data-ws="table-count">
                {count}
              </span>
            )}
            {table.error && (
              <span className="ws-badge ws-fragile" data-ws="table-error">
                !
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        className="ws-btn ws-btn-ghost ws-btn-sm"
        disabled={locked}
        aria-label="Add a table"
        title="Add a table: picks go to the active table"
        onClick={() => void actions.send({ kind: 'draft.addTable' })}
        data-ws="table-add"
      >
        + Table
      </button>
    </section>
  );
}

/** Name and removal of the active table, with its validation error. */
export function ActiveTableBar({ draft }: { draft: Draft }) {
  const actions = useActions();
  const table = draft.tables[draft.activeTable]!;
  const [value, setValue] = useState(table.name);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setValue(table.name);
    setProblem(null);
  }, [table.name, draft.activeTable]);
  const commit = () => {
    const name = value.trim();
    if (name === table.name) return setProblem(null);
    const refused = tableNameProblem(name, draft.tables, draft.activeTable);
    setProblem(refused);
    if (!refused) void actions.send({ kind: 'draft.renameTable', name });
  };
  return (
    <section className="ws-col" data-ws="table-bar">
      <div className="ws-row">
        <span className="ws-caps">Table</span>
        <input
          className={`ws-input ws-input-sm ws-mono-sm ws-spacer${problem ? ' ws-invalid' : ''}`}
          value={value}
          aria-label="Table name"
          aria-invalid={problem ? true : undefined}
          data-ws="table-name"
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        {draft.tables.length > 1 && (
          <button
            type="button"
            className="ws-btn ws-btn-ghost ws-btn-sm"
            aria-label={`Remove table ${table.name}`}
            title="Remove this table with its item container and fields"
            onClick={() => void actions.send({ kind: 'draft.removeTable' })}
            data-ws="table-remove"
          >
            Remove
          </button>
        )}
      </div>
      {problem && (
        <span className="ws-error" data-ws="table-name-error">
          {problem}
        </span>
      )}
      {!problem && table.error && table.fields.length > 0 && (
        <span className="ws-error" data-ws="table-bar-error">
          {table.error}
        </span>
      )}
    </section>
  );
}

/**
 * The tables other than the active one, collapsed: name, container count, and
 * their fields. Clicking the card activates the table; clicking a field also
 * opens it for editing.
 */
export function CollapsedTables({ draft, locked, onEdit }: { draft: Draft; locked: boolean; onEdit: (table: number, index: number) => void }) {
  const actions = useActions();
  const others = draft.tables.map((table, index) => ({ table, index })).filter(({ index }) => index !== draft.activeTable);
  if (others.length === 0) return null;
  return (
    <section className="ws-col" data-ws="collapsed-tables">
      {others.map(({ table, index }) => (
        <div
          key={`${index}-${table.name}`}
          className={`ws-card${locked ? '' : ' ws-clickable'}`}
          data-ws="table-card"
          data-table={table.name}
          title={locked ? undefined : `Activate ${table.name}`}
          onClick={locked ? undefined : () => void actions.send({ kind: 'draft.selectTable', index })}
        >
          <div className="ws-row">
            <span className="ws-mono-sm ws-spacer">{table.name}</span>
            <span className="ws-meta">
              {table.item ? `${table.item.count ?? '…'} items` : 'page'} · {table.fields.length} field{table.fields.length === 1 ? '' : 's'}
            </span>
          </div>
          {table.fields.length > 0 && (
            <div className="ws-row ws-wrap">
              {table.fields.map((field, i) => (
                <button
                  key={`${i}-${field.name}`}
                  type="button"
                  className={`ws-btn ws-btn-ghost ws-btn-sm${field.error ? ' ws-invalid' : ''}`}
                  disabled={locked}
                  title={field.error ?? `Edit ${table.name}.${field.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(index, i);
                  }}
                  data-ws="collapsed-field"
                  data-name={field.name}
                >
                  <span className="ws-mono-sm">{field.name}</span>
                  <span className="ws-num">{field.count ?? '…'}</span>
                </button>
              ))}
            </div>
          )}
          {table.error && (
            <span className="ws-error" data-ws="table-card-error">
              {table.error}
            </span>
          )}
        </div>
      ))}
    </section>
  );
}
