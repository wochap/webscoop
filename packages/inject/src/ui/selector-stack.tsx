import type { ProtocolCandidate } from '@webscoop/core/page';
import { selectorChain } from '../chain';
import { SelectorChip, type SelectorLevel } from './selector-chip';

/** One level of a composed selector: its name, primary selector, level color, and match count. */
export interface StackLevel {
  name: string;
  candidate: ProtocolCandidate | null | undefined;
  level: SelectorLevel;
  /** Matches of the level, or for a field the containers holding a match out of the container count. */
  count?: string | number | null;
  /** A small badge after the chip, such as "inferred" on a derived list parent. */
  badge?: { text: string; testId?: string };
}

/** The list parent, item container, and optional field levels of an item scoped selector, outermost first. */
export function stackLevels(
  within: ProtocolCandidate | null | undefined,
  item: ProtocolCandidate | null | undefined,
  counts: { within?: string | number | null; item?: string | number | null } = {},
  field?: { candidate: ProtocolCandidate | null | undefined; count?: string | number | null },
): StackLevel[] {
  return [
    { name: 'list', candidate: within, level: 'list' as const, count: counts.within ?? null },
    { name: 'item', candidate: item, level: 'item' as const, count: counts.item ?? null },
    ...(field ? [{ name: 'field', candidate: field.candidate, level: 'field' as const, count: field.count ?? null }] : []),
  ];
}

/**
 * The levels of a composed selector stacked vertically, each indented below
 * the previous one with a connector, holding its name, its chip, and its
 * count. Levels that are not set are left out. Display only.
 */
export function SelectorStack({ levels, testId = 'stack' }: { levels: readonly StackLevel[]; testId?: string }) {
  const shown = levels.filter((l): l is StackLevel & { candidate: ProtocolCandidate } => Boolean(l.candidate));
  if (shown.length === 0) return null;
  return (
    <div className="ws-stack" data-ws={testId} data-chain={selectorChain(shown.map((l) => l.candidate))}>
      {shown.map((l, i) => (
        <div key={l.name} className="ws-stack-row" style={{ paddingLeft: i * 14, ['--ws-indent' as string]: `${i * 14}px` }} data-ws="stack-level" data-level={l.level}>
          <span className="ws-stack-label">{l.name}</span>
          <SelectorChip candidate={l.candidate} level={l.level} />
          {l.badge && <StackBadge text={l.badge.text} testId={l.badge.testId} />}
          {l.count !== null && l.count !== undefined && (
            <span className="ws-stack-count" data-ws="stack-count">
              {l.count}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** A badge on a stack row. */
export function StackBadge({ text, testId }: { text: string; testId?: string | undefined }) {
  return (
    <span className="ws-badge ws-badge-outline" data-ws={testId}>
      {text}
    </span>
  );
}
