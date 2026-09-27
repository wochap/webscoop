import type { ProtocolCandidate } from '@webscoop/core/page';
import { Icon, type IconName } from './icons';

export type Strategy = ProtocolCandidate['strategy'];
export type Stability = ProtocolCandidate['stability'];
/** The level a selector belongs to; each has its own stripe color. */
export type SelectorLevel = 'list' | 'item' | 'field' | 'page';

/** The strategies in the order the selector input lists them. */
export const STRATEGIES: readonly Strategy[] = ['role', 'testid', 'id', 'class', 'text', 'css', 'xpath'];

/** The tag each strategy shows: an icon, or a short glyph. */
export const STRATEGY_TAGS: Record<Strategy, { icon?: IconName; text?: string; name: string }> = {
  role: { icon: 'person-simple', name: 'role' },
  testid: { icon: 'flask', name: 'test id' },
  id: { text: '#', name: 'id' },
  class: { text: '.', name: 'class' },
  text: { icon: 'text-t', name: 'text' },
  css: { text: '{}', name: 'css' },
  xpath: { text: '//', name: 'xpath' },
};

const STABILITY_LABEL: Record<Stability, string> = { stable: 'stable', medium: 'medium stability', fragile: 'fragile' };

export interface SelectorDisplay {
  strategy: Strategy;
  /** The prettified value, without the quoted part. */
  main: string;
  /** A quoted part shown in the accent color: the role's label, or a text value. */
  quoted: string;
  /** The value started with `:scope >`: a direct child of its container. */
  direct: boolean;
  /** `strategy=value` with the stability, for the hover title. */
  full: string;
}

/**
 * How a selector reads in a chip: a leading `:scope >` becomes the direct
 * child marker, a role `name|label` reads `name "label"`, a text value is
 * quoted, and the leading `#`, `.`, and `//` of id, class, and xpath values
 * are dropped (the strategy tag already says so).
 */
export function selectorDisplay(candidate: Pick<ProtocolCandidate, 'strategy' | 'value' | 'stability'>): SelectorDisplay {
  const { strategy, value: raw, stability } = candidate;
  let value = raw;
  let direct = false;
  const scope = /^:scope\s*>\s*/.exec(value);
  if (scope) {
    direct = true;
    value = value.slice(scope[0].length);
  }
  let main = value;
  let quoted = '';
  if (strategy === 'role' && value.includes('|')) {
    const i = value.indexOf('|');
    main = value.slice(0, i);
    quoted = ` "${value.slice(i + 1)}"`;
  } else if (strategy === 'text') {
    main = '';
    quoted = `"${value}"`;
  } else if (strategy === 'id') main = value.replace(/^#/, '');
  else if (strategy === 'class') main = value.replace(/^\./, '');
  else if (strategy === 'xpath') main = value.replace(/^\/\//, '');
  return { strategy, main, quoted, direct, full: `${strategy}=${raw} · ${STABILITY_LABEL[stability]}` };
}

export function StrategyTag({ strategy }: { strategy: Strategy }) {
  const tag = STRATEGY_TAGS[strategy];
  return tag.icon ? <Icon name={tag.icon} weight="bold" size={11} /> : <>{tag.text}</>;
}

/**
 * A saved or candidate selector, display only: strategy tag, prettified
 * value cut with an ellipsis, stability dot, and the level's stripe. The
 * full `strategy=value` and stability show on hover.
 */
export function SelectorChip({
  candidate,
  level = 'field',
  className,
}: {
  candidate: Pick<ProtocolCandidate, 'strategy' | 'value' | 'stability'>;
  level?: SelectorLevel;
  className?: string;
}) {
  const d = selectorDisplay(candidate);
  return (
    <span
      className={`ws-sel-chip${className ? ` ${className}` : ''}`}
      title={d.full}
      data-ws="selector-chip"
      data-level={level}
      data-strategy={d.strategy}
      data-selector={`${candidate.strategy}=${candidate.value}`}
    >
      <span className="ws-sel-tag" title={STRATEGY_TAGS[d.strategy].name}>
        <StrategyTag strategy={d.strategy} />
      </span>
      <span className="ws-sel-body">
        {d.direct && (
          <span className="ws-sel-direct" title="direct child (:scope >)" data-ws="selector-direct">
            ↳
          </span>
        )}
        <span className="ws-sel-value" data-ws="selector-value">
          {d.main}
          {d.quoted && <span className="ws-sel-quoted">{d.quoted}</span>}
        </span>
        <span className="ws-sel-dot" data-stability={candidate.stability} title={STABILITY_LABEL[candidate.stability]} />
      </span>
    </span>
  );
}
