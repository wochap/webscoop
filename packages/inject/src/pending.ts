import { parseSelector } from '@webscoop/core/page';

/**
 * Why selector text cannot be a selector, as far as the panel can tell
 * before sending it; null when it may be applied. The host's verdicts (no
 * match, out of scope) arrive later.
 */
export function selectorSyntaxError(text: string): string | null {
  const { strategy, value } = parseSelector(text);
  if (!value) return 'empty selector';
  const css = strategy === 'css' ? value : strategy === 'class' ? value.split(/\s+/).filter(Boolean).map((c) => `.${CSS.escape(c)}`).join('') : strategy === 'id' ? `#${CSS.escape(value)}` : null;
  try {
    if (css !== null) document.createDocumentFragment().querySelector(css);
    else if (strategy === 'xpath') document.createExpression(value);
  } catch {
    return `invalid ${strategy} selector`;
  }
  return null;
}

/** A selector input with pending text: `apply` checks and submits it, returning false when it cannot. */
interface PendingEntry {
  group: string;
  apply: () => boolean;
}

export interface PendingSelectors {
  /** Adds or replaces the entry of `id`; returns its removal. */
  register: (id: string, entry: PendingEntry) => () => void;
  /** Applies every pending entry of the group; false when any could not. */
  applyPending: (group: string) => boolean;
  /** Applies the pending entry of `id`, if any; false when it could not. */
  applyPendingId: (id: string) => boolean;
}

export function createPendingSelectors(): PendingSelectors {
  const entries = new Map<string, PendingEntry>();
  return {
    register: (id, entry) => {
      entries.set(id, entry);
      return () => {
        if (entries.get(id) === entry) entries.delete(id);
      };
    },
    applyPending: (group) => {
      let ok = true;
      for (const entry of [...entries.values()]) if (entry.group === group && !entry.apply()) ok = false;
      return ok;
    },
    applyPendingId: (id) => entries.get(id)?.apply() ?? true,
  };
}
