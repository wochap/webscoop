import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { TestResults, TestTable } from '@webscoop/core/page';
import { useDrawerHost } from './context';

export function TestRunSummary({ results, durationMs }: { results: TestTable; durationMs: number }) {
  return (
    <span className="ws-row" data-ws="test-summary">
      <span className="ws-title" data-ws="test-rows">
        {results.rowCount} row{results.rowCount === 1 ? '' : 's'}
      </span>
      {results.dropped.count > 0 && (
        <span className="ws-badge ws-medium" data-ws="test-dropped">
          {results.dropped.count} row{results.dropped.count === 1 ? '' : 's'} dropped: {results.dropped.fields.join(', ')}
        </span>
      )}
      <span className="ws-meta">in {durationMs} ms · page 1 only</span>
    </span>
  );
}

const STATUS_TONE = { ok: 'ws-stable', healed: 'ws-stable', partial: 'ws-medium', missing: 'ws-fragile' } as const;

export function FieldStatusList({ fields }: { fields: TestTable['fields'] }) {
  return (
    <span className="ws-row ws-wrap" data-ws="field-status">
      {fields.map((f) => (
        <span key={f.name} className="ws-status" data-ws="field-status-item" data-field={f.name} data-status={f.status}>
          <span className="ws-mono-sm">{f.name}</span>
          <span className={`ws-badge ${STATUS_TONE[f.status]}`}>{f.status}</span>
        </span>
      ))}
    </span>
  );
}

/** The run's error, the shown table's error, then the warnings. */
export function RunLog({ results, table }: { results: TestResults; table?: TestTable | undefined }) {
  const errors = [...(results.error ? [results.error] : []), ...(table?.error ? [table.error] : [])];
  const lines = [...errors, ...results.warnings];
  if (lines.length === 0) return null;
  return (
    <div className="ws-col" data-ws="run-log" style={{ padding: '6px 12px' }}>
      {lines.map((line, i) => (
        <span key={i} className={i < errors.length ? 'ws-error' : 'ws-meta'} style={{ whiteSpace: 'pre-wrap' }}>
          {line}
        </span>
      ))}
    </div>
  );
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function ResultsTable({ rows }: { rows: TestTable['rows'] }) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== '_page');
  return (
    <table className="ws-table" data-ws="results-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c === '_index' ? '#' : c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} data-ws="result-row">
            {columns.map((c) => (
              <td key={c} title={cell(row[c])}>
                {cell(row[c])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One tab per table with its row count; shown only when the run has more than one table. */
export function ResultTabs({ tables, shown, onShow }: { tables: TestTable[]; shown: string; onShow: (name: string) => void }) {
  if (tables.length < 2) return null;
  return (
    <div className="ws-seg" role="tablist" aria-label="Result tables" data-ws="result-tabs">
      {tables.map((t) => (
        <button key={t.name} type="button" role="tab" aria-selected={t.name === shown} aria-pressed={t.name === shown} onClick={() => onShow(t.name)} data-ws="result-tab" data-table={t.name}>
          {t.name} · {t.rowCount}
        </button>
      ))}
    </div>
  );
}

/**
 * Bottom drawer in the page area, left of the panel, with one tab per table,
 * opened on the active table. Renders into its own host so the panel's
 * containment does not trap it.
 */
export function ResultsDrawer({
  results,
  active,
  view,
  onView,
  onClose,
}: {
  results: TestResults;
  /** Name of the active table: the tab shown first. */
  active?: string | undefined;
  view: 'table' | 'json';
  onView: (view: 'table' | 'json') => void;
  onClose: () => void;
}) {
  const host = useDrawerHost();
  const [picked, setPicked] = useState<string | null>(null);
  const table = results.tables.find((t) => t.name === (picked ?? active)) ?? results.tables[0];
  const rows = table?.rows ?? [];
  const drawer = (
    <div id="ws-drawer" data-ws="drawer" role="region" aria-label="Test run results">
      <div className="ws-drawer-head">
        <ResultTabs tables={results.tables} shown={table?.name ?? ''} onShow={setPicked} />
        {table ? (
          <>
            <TestRunSummary results={table} durationMs={results.durationMs} />
            <FieldStatusList fields={table.fields} />
          </>
        ) : (
          <span className="ws-meta">in {results.durationMs} ms · page 1 only</span>
        )}
        <span className="ws-spacer" />
        <div className="ws-seg" role="group" aria-label="Results view">
          <button type="button" aria-pressed={view === 'table'} onClick={() => onView('table')} data-ws="view-table">
            Table
          </button>
          <button type="button" aria-pressed={view === 'json'} onClick={() => onView('json')} data-ws="view-json">
            JSON
          </button>
        </div>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={onClose} aria-label="Close results" data-ws="drawer-close">
          ×
        </button>
      </div>
      <RunLog results={results} table={table} />
      <div className="ws-drawer-body">
        {view === 'table' ? <ResultsTable rows={rows} /> : <pre className="ws-json" data-ws="results-json">{JSON.stringify(rows, null, 2)}</pre>}
      </div>
    </div>
  );
  return host ? createPortal(drawer, host) : drawer;
}
