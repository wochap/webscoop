import { createPortal } from 'react-dom';
import type { TestResults } from '@webscoop/core/page';
import { useDrawerHost } from './context';

export function TestRunSummary({ results }: { results: TestResults }) {
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
      <span className="ws-meta">in {results.durationMs} ms · page 1 only</span>
    </span>
  );
}

const STATUS_TONE = { ok: 'ws-stable', healed: 'ws-stable', partial: 'ws-medium', missing: 'ws-fragile' } as const;

export function FieldStatusList({ fields }: { fields: TestResults['fields'] }) {
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

export function RunLog({ results }: { results: TestResults }) {
  const lines = [...(results.error ? [results.error] : []), ...results.warnings];
  if (lines.length === 0) return null;
  return (
    <div className="ws-col" data-ws="run-log" style={{ padding: '6px 12px' }}>
      {lines.map((line, i) => (
        <span key={i} className={i === 0 && results.error ? 'ws-error' : 'ws-meta'} style={{ whiteSpace: 'pre-wrap' }}>
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

export function ResultsTable({ rows }: { rows: TestResults['rows'] }) {
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

/**
 * Bottom drawer in the page area, left of the panel. Renders into its own
 * host so the panel's containment does not trap it.
 */
export function ResultsDrawer({
  results,
  view,
  onView,
  onClose,
}: {
  results: TestResults;
  view: 'table' | 'json';
  onView: (view: 'table' | 'json') => void;
  onClose: () => void;
}) {
  const host = useDrawerHost();
  const drawer = (
    <div id="ws-drawer" data-ws="drawer" role="region" aria-label="Test run results">
      <div className="ws-drawer-head">
        <TestRunSummary results={results} />
        <FieldStatusList fields={results.fields} />
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
      <RunLog results={results} />
      <div className="ws-drawer-body">
        {view === 'table' ? <ResultsTable rows={results.rows} /> : <pre className="ws-json" data-ws="results-json">{JSON.stringify(results.rows, null, 2)}</pre>}
      </div>
    </div>
  );
  return host ? createPortal(drawer, host) : drawer;
}
