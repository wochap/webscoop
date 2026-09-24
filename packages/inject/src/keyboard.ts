export type Shortcut =
  | 'pick'
  | 'cancel'
  | 'closeMenu'
  | 'confirm'
  | 'walkUp'
  | 'walkDown'
  | 'moveUp'
  | 'moveDown'
  | 'moveStepUp'
  | 'moveStepDown'
  | 'browse'
  | 'stopBrowse'
  | 'save'
  | 'skip'
  | 'abort';

export interface KeyLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface ShortcutContext {
  /** Focus is in a text input, textarea, select, or editable element. */
  typing: boolean;
  picking: boolean;
  menuOpen: boolean;
  hasProposal: boolean;
  hasSelection: boolean;
  focusedField: number | null;
  /** Step row that has keyboard focus, for Alt+Up and Alt+Down. */
  focusedStep?: number | null;
  /** Browse mode is on: page interaction is recorded as steps. */
  browsing?: boolean;
  /** The focused re-pick mode is active. */
  repicking?: boolean;
}

/** Whether the event target is a place the user types into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
  }
  return el.isContentEditable === true;
}

/**
 * Map a key press to a panel shortcut: `p` picks, `b` toggles browse mode,
 * Esc cancels picking, closes a menu, or leaves browse mode, Enter confirms
 * the item proposal, Left and Right walk the breadcrumb, Alt+Up and Alt+Down
 * reorder the focused field or step, Ctrl+S saves.
 * While re-picking, `s` skips the field and Esc (when not picking) aborts.
 * Nothing fires while typing.
 */
export function shortcutFor(e: KeyLike, ctx: ShortcutContext): Shortcut | null {
  if (ctx.typing) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 's') return 'save';
  if (e.key === 'Escape') {
    if (ctx.menuOpen) return 'closeMenu';
    if (ctx.picking) return 'cancel';
    if (ctx.browsing) return 'stopBrowse';
    if (ctx.repicking) return 'abort';
    return null;
  }
  if (mod) return null;
  if (ctx.repicking && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) return 'skip';
  if (e.altKey) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return null;
    const up = e.key === 'ArrowUp';
    if (ctx.focusedStep !== undefined && ctx.focusedStep !== null) return up ? 'moveStepUp' : 'moveStepDown';
    if (ctx.focusedField === null) return null;
    return up ? 'moveUp' : 'moveDown';
  }
  if (e.shiftKey) return null;
  if (ctx.picking) return null;
  if (e.key === 'p' || e.key === 'P') return 'pick';
  if ((e.key === 'b' || e.key === 'B') && !ctx.repicking) return ctx.browsing ? 'stopBrowse' : 'browse';
  if (e.key === 'Enter' && ctx.hasProposal) return 'confirm';
  if (e.key === 'ArrowLeft' && ctx.hasSelection) return 'walkUp';
  if (e.key === 'ArrowRight' && ctx.hasSelection) return 'walkDown';
  return null;
}

/** The crumb one step up (`-1`) or back down (`+1`) from the current path along the trail. */
export function walkTrail<T extends { path: readonly number[] }>(trail: readonly T[], current: readonly number[], delta: -1 | 1): T | null {
  const key = current.join('.');
  const index = trail.findIndex((c) => c.path.join('.') === key);
  if (index === -1) return null;
  return trail[index + delta] ?? null;
}
