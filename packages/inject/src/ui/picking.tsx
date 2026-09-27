import { useState } from 'react';
import { classifyToken, attrStability, type Crumb, type ParsedSelection, type Path } from '@webscoop/core/page';
import { walkTrail } from '../keyboard';
import type { HoverInfo } from '../store';
import { Icon } from './icons';
import { SelectorStack, type StackLevel } from './selector-stack';
import { Kbd } from './shell';

export function PickModeStrip({
  picking,
  onStart,
  onCancel,
  level,
  hover = null,
}: {
  picking: boolean;
  onStart: () => void;
  onCancel: () => void;
  /** Set while picking a list level: only some elements can be picked. */
  level?: 'within' | 'item' | null;
  /** What is hovered on the page while picking. */
  hover?: HoverInfo | null;
}) {
  if (picking) {
    const title = level === 'within' ? 'Click the element that holds every item' : level === 'item' ? 'Click one item inside the list' : 'Picking on the page';
    return (
      <div className="ws-pick-card">
        <div className="ws-strip ws-strip-active" data-ws="pick-strip" data-picking="true" data-level={level ?? undefined}>
          <span className="ws-pick-dot" />
          <span className="ws-title ws-spacer">{title}</span>
          <button type="button" className="ws-btn ws-btn-sm" onClick={onCancel} data-ws="pick-cancel">
            Cancel <Kbd>Esc</Kbd>
          </button>
        </div>
        {hover && <HoveringCard hover={hover} />}
      </div>
    );
  }
  return (
    <div className="ws-strip" data-ws="pick-strip" data-picking="false">
      <span className="ws-spacer ws-meta">Pick an element on the page to inspect it.</span>
      <button type="button" className="ws-btn ws-btn-primary" onClick={onStart} data-ws="pick-start">
        <Icon name="crosshair-simple" size={13} />
        Pick element <Kbd>P</Kbd>
      </button>
    </div>
  );
}

/** While picking: the walk distance, the repeat count, and the path from the hover target down to the start element. */
export function HoveringCard({ hover }: { hover: HoverInfo }) {
  const last = hover.path.length - 1;
  return (
    <section className="ws-hover-card" data-ws="pick-hover" data-depth={hover.depth}>
      <span className="ws-meta">Hovering</span>
      {(hover.depth > 0 || hover.similar >= 2) && (
        <div className="ws-row">
          {hover.depth > 0 && (
            <span className="ws-badge ws-tone-accent" data-ws="pick-hover-depth">
              ↑{hover.depth}
            </span>
          )}
          {hover.similar >= 2 && (
            <span className="ws-meta" style={{ color: 'var(--ws-ok)' }} data-ws="pick-hover-similar">
              {hover.similar} similar siblings
            </span>
          )}
        </div>
      )}
      <div className="ws-hover-path" data-ws="pick-hover-path">
        {hover.path.map((label, i) => (
          <span key={i} style={{ display: 'contents' }}>
            {i > 0 && <span className="ws-crumb-sep">‹</span>}
            <span className={i === 0 ? 'ws-hover-current' : undefined} data-ws="pick-hover-step">
              {label}
            </span>
            {i === last && last > 0 && <span className="ws-faint">· start</span>}
          </span>
        ))}
      </div>
      <span className="ws-meta" data-ws="pick-hover-hint">
        Wrappers are hard to click — hover any child and press <Kbd>↑</Kbd> until the whole item is outlined.
      </span>
    </section>
  );
}

/** Attributes the inspector shows: id, data-testid, class, and aria-*. */
export function inspectedAttrs(attrs: Record<string, string>): [string, string][] {
  return Object.entries(attrs)
    .filter(([name]) => name === 'id' || name === 'data-testid' || name === 'class' || name.startsWith('aria-'))
    .sort(([a], [b]) => a.localeCompare(b));
}

function Flag({ stable }: { stable: boolean }) {
  return <span className={`ws-badge ${stable ? 'ws-stable' : 'ws-hashed'}`}>{stable ? 'stable' : 'hashed'}</span>;
}

export function AttrTable({ attrs }: { attrs: Record<string, string> }) {
  const rows = inspectedAttrs(attrs);
  if (rows.length === 0) return <span className="ws-meta">No id, data-testid, class, or aria attributes.</span>;
  return (
    <div className="ws-attrs" data-ws="pick-attrs">
      {rows.map(([name, value]) =>
        name === 'class' ? (
          value
            .split(/\s+/)
            .filter(Boolean)
            .map((token, i) => (
              <AttrLine key={`class-${i}`} name={i === 0 ? 'class' : ''} value={token} stable={classifyToken(token) === 'stable'} />
            ))
        ) : (
          <AttrLine key={name} name={name} value={value} stable={attrStability(name, value) === 'stable'} />
        ),
      )}
    </div>
  );
}

function AttrLine({ name, value, stable }: { name: string; value: string; stable: boolean }) {
  return (
    <>
      <span className="ws-mono-sm ws-faint">{name}</span>
      <span className="ws-mono-sm ws-ellipsis" title={value} data-ws="pick-attr-value" data-stable={stable}>
        {value}
      </span>
      <Flag stable={stable} />
    </>
  );
}

export function CrumbChip({ crumb, current, onClick }: { crumb: Crumb; current: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`ws-crumb${current ? ' ws-crumb-current' : ''}`}
      onClick={onClick}
      aria-current={current ? 'true' : undefined}
      data-ws="pick-crumb"
      data-path={crumb.path.join('.')}
    >
      {crumb.label}
    </button>
  );
}

/** How many crumbs the breadcrumb shows, ending at the current selection, before it is expanded. */
export const SHOWN_CRUMBS = 3;

/** The crumbs shown: all when expanded, else the last three up to the current selection. The flag says whether some are hidden. */
export function shownCrumbs(trail: readonly Crumb[], current: Path, expanded: boolean): { crumbs: Crumb[]; hidden: number } {
  if (expanded) return { crumbs: [...trail], hidden: 0 };
  const key = current.join('.');
  const at = trail.findIndex((c) => c.path.join('.') === key);
  const end = at === -1 ? trail.length : at + 1;
  const start = Math.max(0, end - SHOWN_CRUMBS);
  return { crumbs: trail.slice(start, end), hidden: trail.length - (end - start) };
}

/**
 * Ancestors from body down to the originally picked element: the last three
 * up to the selection, behind an expander that shows every crumb. Left and
 * Right (on the breadcrumb or anywhere in the panel) walk up and back down.
 */
export function AncestorBreadcrumb({ trail, current, onSelect }: { trail: Crumb[]; current: Path; onSelect: (path: Path) => void }) {
  const [expanded, setExpanded] = useState(false);
  const key = current.join('.');
  const walk = (delta: -1 | 1) => {
    const next = walkTrail(trail, current, delta);
    if (next) onSelect(next.path);
  };
  const { crumbs, hidden } = shownCrumbs(trail, current, expanded);
  return (
    <div
      className="ws-crumbs"
      data-ws="pick-breadcrumb"
      data-expanded={expanded || undefined}
      tabIndex={0}
      aria-label="Ancestors"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          walk(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          walk(1);
        }
      }}
    >
      {hidden > 0 && (
        <button type="button" className="ws-crumb" title={`Show all ${trail.length} crumbs`} aria-label={`Show ${hidden} more ancestors`} onClick={() => setExpanded(true)} data-ws="pick-crumb-expand">
          …
        </button>
      )}
      {crumbs.map((crumb, i) => (
        <span key={crumb.path.join('.') || 'root'} style={{ display: 'contents' }}>
          {(i > 0 || hidden > 0) && <span className="ws-crumb-sep">›</span>}
          <CrumbChip crumb={crumb} current={crumb.path.join('.') === key} onClick={() => onSelect(crumb.path)} />
        </span>
      ))}
    </div>
  );
}

export function ElementInspector({
  selection,
  trail,
  onSelectPath,
  chain = [],
  onClear,
}: {
  selection: ParsedSelection;
  trail: Crumb[];
  onSelectPath: (path: Path) => void;
  /** Clear the selection, back to the empty state. */
  onClear?: () => void;
  /** The composed selector stack, for an item scoped selection. */
  chain?: readonly StackLevel[];
}) {
  return (
    <section className="ws-card" data-ws="pick-inspector">
      <div className="ws-row">
        <span className="ws-mono" style={{ color: 'var(--ws-accent-400)' }} data-ws="pick-inspector-tag">
          {selection.tag}
        </span>
        {selection.role && <span className="ws-meta">{selection.role}</span>}
        {selection.name && (
          <span className="ws-meta ws-ellipsis" title={selection.name} data-ws="pick-inspector-name">
            “{selection.name}”
          </span>
        )}
        {onClear && (
          <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" style={{ marginLeft: 'auto' }} aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear} data-ws="pick-clear">
            <Icon name="x" size={11} />
          </button>
        )}
      </div>
      {selection.text && (
        <span className="ws-meta ws-ellipsis" title={selection.text} data-ws="pick-inspector-text">
          {selection.text}
        </span>
      )}
      <AttrTable attrs={selection.attrs} />
      <SelectorStack levels={chain} testId="pick-inspector-stack" />
      <AncestorBreadcrumb trail={trail.length > 0 ? trail : selection.ancestors} current={selection.path} onSelect={onSelectPath} />
    </section>
  );
}
