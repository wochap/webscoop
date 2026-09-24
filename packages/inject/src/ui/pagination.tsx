import { useState } from 'react';
import { STOP_RULES, type DraftPagination, type PaginationPatch } from '@webscoop/core/page';
import { useActions } from './context';
import { Toggle } from './items';

type Kind = DraftPagination['kind'];

const KINDS: { kind: Exclude<Kind, 'none'>; label: string; hint: string }[] = [
  { kind: 'url', label: 'URL', hint: 'page number in the URL' },
  { kind: 'next', label: 'Next', hint: 'follow a next link' },
  { kind: 'more', label: 'More', hint: 'click load more' },
  { kind: 'scroll', label: 'Scroll', hint: 'infinite scroll' },
];

const STOP_LABELS: Record<(typeof STOP_RULES)[number], string> = {
  'no-new-items': 'Stop when a page adds no new items',
  'first-item-repeats': 'Stop when the first item repeats',
  'target-missing': 'Stop when the target disappears',
};

export function SegmentedControl<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <div className="ws-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)} data-ws={`seg-${o.value}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NumberStepper({ value, min = 0, onChange, label }: { value: number; min?: number; onChange: (value: number) => void; label: string }) {
  const set = (n: number) => onChange(Math.max(min, Math.round(n)));
  return (
    <span className="ws-stepper">
      <button type="button" className="ws-btn ws-btn-sm" aria-label={`Decrease ${label}`} onClick={() => set(value - 1)}>
        −
      </button>
      <input
        className="ws-input ws-input-sm ws-mono-sm"
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) set(n);
        }}
      />
      <button type="button" className="ws-btn ws-btn-sm" aria-label={`Increase ${label}`} onClick={() => set(value + 1)}>
        +
      </button>
    </span>
  );
}

export function KindOption({ kind, label, hint, active, onChoose }: { kind: Kind; label: string; hint: string; active: boolean; onChoose: () => void }) {
  return (
    <button type="button" className="ws-kind" aria-pressed={active} onClick={onChoose} data-ws={`kind-${kind}`}>
      <span className="ws-title">{label}</span>
      <span className="ws-meta">{hint}</span>
    </button>
  );
}

export function TargetSummary({ pagination }: { pagination: DraftPagination }) {
  const primary = pagination.target?.selectors[0];
  return (
    <div className="ws-col" data-ws="pagination-target">
      <span className="ws-caps">Target</span>
      {primary ? (
        <span className="ws-mono-sm ws-ellipsis" title={primary.value}>
          {primary.strategy}={primary.value}
        </span>
      ) : (
        <span className="ws-meta">{pagination.kind === 'scroll' ? 'No target: the page loads more while scrolling.' : 'No target picked.'}</span>
      )}
      {pagination.kind === 'url' && pagination.param && (
        <span className="ws-meta" data-ws="pagination-param">
          parameter <span className="ws-mono-sm">{pagination.param.name}</span> from {pagination.param.start}, step {pagination.param.step}
        </span>
      )}
    </div>
  );
}

type LimitChoice = 'first' | 'n' | 'all';

export function PaginationEditor({ pagination }: { pagination: DraftPagination }) {
  const actions = useActions();
  const update = (patch: PaginationPatch) => void actions.send({ kind: 'draft.updatePagination', patch });
  const [pages, setPages] = useState(typeof pagination.limit === 'number' && pagination.limit > 1 ? pagination.limit : 3);
  const choice: LimitChoice = pagination.limit === 'all' ? 'all' : pagination.limit === 1 ? 'first' : 'n';
  return (
    <section className="ws-card" data-ws="pagination">
      <div className="ws-row ws-row-between">
        <span className="ws-caps">Pagination</span>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.clearPagination' })} data-ws="clear-pagination">
          Remove
        </button>
      </div>
      <div className="ws-kinds">
        {KINDS.map((k) => (
          <KindOption key={k.kind} {...k} active={pagination.kind === k.kind} onChoose={() => update({ kind: k.kind })} />
        ))}
      </div>
      <TargetSummary pagination={pagination} />
      <div className="ws-col">
        <span className="ws-caps">Limit</span>
        <SegmentedControl<LimitChoice>
          label="Page limit"
          value={choice}
          options={[
            { value: 'first', label: 'First page' },
            { value: 'n', label: `First ${pages} pages` },
            { value: 'all', label: 'All pages' },
          ]}
          onChange={(value) => update({ limit: value === 'first' ? 1 : value === 'all' ? 'all' : pages })}
        />
        {choice === 'n' && (
          <NumberStepper
            label="Pages"
            min={2}
            value={pages}
            onChange={(n) => {
              setPages(n);
              update({ limit: n });
            }}
          />
        )}
      </div>
      <div className="ws-col">
        <span className="ws-caps">Stop rules</span>
        {STOP_RULES.map((rule) => {
          const on = pagination.stopRules.includes(rule);
          return (
            <div key={rule} className="ws-row">
              <span className="ws-spacer">{STOP_LABELS[rule]}</span>
              <Toggle
                on={on}
                label={STOP_LABELS[rule]}
                testId={`stop-${rule}`}
                onChange={(next) => update({ stopRules: next ? [...pagination.stopRules, rule] : pagination.stopRules.filter((r) => r !== rule) })}
              />
            </div>
          );
        })}
      </div>
      <span className="ws-meta">Recorded only: pagination runs arrive in a later version.</span>
    </section>
  );
}
