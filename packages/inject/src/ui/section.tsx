import type { ReactNode } from 'react';
import { Icon } from './icons';

/**
 * One panel section: a header with the title, a count when it lists things,
 * and its actions on the right, above the content. A collapsible section has
 * a chevron and shows its one-line summary instead of its content when
 * collapsed. Sections are separated by a divider that fades at its ends.
 */
export function Section({
  id,
  title,
  count,
  actions,
  collapsible = false,
  collapsed = false,
  onCollapse,
  summary,
  children,
}: {
  /** Used for the `data-ws` hook, `section-<id>`. */
  id: string;
  title: string;
  count?: number | null;
  actions?: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  /** The one-line summary shown while collapsed. */
  summary?: ReactNode;
  children?: ReactNode;
}) {
  const shut = collapsible && collapsed;
  const head = (
    <>
      <span className="ws-section-title">{title}</span>
      {count !== undefined && count !== null && (
        <span className="ws-section-count" data-ws="section-count">
          {count}
        </span>
      )}
    </>
  );
  return (
    <section className="ws-section" data-ws={`section-${id}`} data-collapsed={shut || undefined}>
      <div className="ws-section-head">
        {collapsible ? (
          <button
            type="button"
            className="ws-section-toggle"
            aria-expanded={!shut}
            aria-label={`${shut ? 'Expand' : 'Collapse'} ${title}`}
            onClick={() => onCollapse?.(!shut)}
            data-ws="section-toggle"
          >
            <Icon name={shut ? 'caret-right' : 'caret-down'} size={10} />
            {head}
          </button>
        ) : (
          head
        )}
        {shut && summary !== undefined && (
          <span className="ws-section-summary" data-ws="section-summary">
            {summary}
          </span>
        )}
        {actions && <span className="ws-section-actions">{actions}</span>}
      </div>
      {!shut && children}
    </section>
  );
}
