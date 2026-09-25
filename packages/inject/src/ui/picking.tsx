import { classifyToken, attrStability, type Crumb, type ParsedSelection, type Path } from '@webscoop/core/page';
import { walkTrail } from '../keyboard';
import { Kbd } from './shell';

export function PickModeStrip({
  picking,
  onStart,
  onCancel,
  level,
}: {
  picking: boolean;
  onStart: () => void;
  onCancel: () => void;
  /** Set while picking a list level: only some elements can be picked. */
  level?: 'within' | 'item' | null;
}) {
  if (picking) {
    const title = level === 'within' ? 'Click the element that holds every item' : level === 'item' ? 'Click one item inside the list' : 'Hover and click an element';
    return (
      <div className="ws-strip ws-strip-active" data-ws="pick-strip" data-picking="true" data-level={level ?? undefined}>
        <div className="ws-col ws-spacer">
          <span className="ws-title">{title}</span>
          <span className="ws-meta">
            <Kbd>Alt</Kbd> + click picks through overlays · <Kbd>Esc</Kbd> cancels
          </span>
        </div>
        <button type="button" className="ws-btn ws-btn-sm" onClick={onCancel} data-ws="pick-cancel">
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="ws-strip" data-ws="pick-strip" data-picking="false">
      <span className="ws-spacer ws-meta">Pick an element on the page to inspect it.</span>
      <button type="button" className="ws-btn ws-btn-primary" onClick={onStart} data-ws="pick">
        Pick element <Kbd>P</Kbd>
      </button>
    </div>
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
    <div className="ws-attrs" data-ws="attrs">
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
      <span className="ws-mono-sm ws-ellipsis" title={value} data-ws="attr-value" data-stable={stable}>
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
      data-ws="crumb"
      data-path={crumb.path.join('.')}
    >
      {crumb.label}
    </button>
  );
}

/**
 * Ancestors from body down to the originally picked element. Left and Right
 * (on the breadcrumb or anywhere in the panel) walk up and back down.
 */
export function AncestorBreadcrumb({ trail, current, onSelect }: { trail: Crumb[]; current: Path; onSelect: (path: Path) => void }) {
  const key = current.join('.');
  const walk = (delta: -1 | 1) => {
    const next = walkTrail(trail, current, delta);
    if (next) onSelect(next.path);
  };
  return (
    <div
      className="ws-crumbs"
      data-ws="breadcrumb"
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
      {trail.map((crumb, i) => (
        <span key={crumb.path.join('.') || 'root'} style={{ display: 'contents' }}>
          {i > 0 && <span className="ws-crumb-sep">›</span>}
          <CrumbChip crumb={crumb} current={crumb.path.join('.') === key} onClick={() => onSelect(crumb.path)} />
        </span>
      ))}
    </div>
  );
}

export function ElementInspector({ selection, trail, onSelectPath }: { selection: ParsedSelection; trail: Crumb[]; onSelectPath: (path: Path) => void }) {
  return (
    <section className="ws-card" data-ws="inspector">
      <div className="ws-row">
        <span className="ws-mono" style={{ color: 'var(--ws-accent-300)' }} data-ws="inspector-tag">
          {selection.tag}
        </span>
        {selection.role && <span className="ws-meta">{selection.role}</span>}
        {selection.name && (
          <span className="ws-meta ws-ellipsis" title={selection.name} data-ws="inspector-name">
            “{selection.name}”
          </span>
        )}
      </div>
      {selection.text && (
        <span className="ws-meta ws-ellipsis" title={selection.text} data-ws="inspector-text">
          {selection.text}
        </span>
      )}
      <AttrTable attrs={selection.attrs} />
      <AncestorBreadcrumb trail={trail.length > 0 ? trail : selection.ancestors} current={selection.path} onSelect={onSelectPath} />
    </section>
  );
}
