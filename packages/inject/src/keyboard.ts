export type Shortcut =
  | 'pick'
  | 'cancel'
  | 'closeMenu'
  | 'confirm'
  | 'setupList'
  | 'closeSetup'
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
  | 'abort'
  | 'cancelEdit'
  | 'clearSelection'
  | 'moveTabLeft'
  | 'moveTabRight'
  | 'renameTab'
  | 'cancelRename';

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
  /** The list setup is open. */
  hasProposal: boolean;
  /** The list setup's item level matches at least one element; Enter accepts only then. */
  canConfirm?: boolean;
  /** The list suggestion is shown: `L` opens the list setup from it. */
  canSetupList?: boolean;
  hasSelection: boolean;
  focusedField: number | null;
  /** Step row that has keyboard focus, for Alt+Up and Alt+Down. */
  focusedStep?: number | null;
  /** Browse mode is on: page interaction is recorded as steps. */
  browsing?: boolean;
  /** The focused re-pick mode is active. */
  repicking?: boolean;
  /** A saved field is open in the selection panel. */
  editing?: boolean;
  /** Table tab that has keyboard focus. */
  focusedTab?: number | null;
  /** A table tab is being renamed. */
  renaming?: boolean;
  /** The list setup is open: tabs do not switch or move. */
  tabsLocked?: boolean;
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
 * `L` opens the list setup from the list suggestion, Esc closes a menu,
 * cancels a tab rename, cancels picking, closes the list setup, leaves browse
 * mode, aborts a re-pick, cancels a field edit, or clears the selection, the
 * first that applies; Enter accepts the list setup while its item matches
 * something, Left and Right walk the breadcrumb, Alt+Up and Alt+Down
 * reorder the focused field or step, Alt+Left and Alt+Right move the
 * focused table tab, F2 renames it, Ctrl+S saves.
 * While re-picking, `s` skips the field and Esc (when not picking) aborts.
 * Nothing fires while typing.
 */
export function shortcutFor(e: KeyLike, ctx: ShortcutContext): Shortcut | null {
  if (ctx.typing) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 's') return 'save';
  if (e.key === 'Escape') {
    if (ctx.menuOpen) return 'closeMenu';
    if (ctx.renaming) return 'cancelRename';
    if (ctx.picking) return 'cancel';
    if (ctx.hasProposal) return 'closeSetup';
    if (ctx.browsing) return 'stopBrowse';
    if (ctx.repicking) return 'abort';
    if (ctx.editing) return 'cancelEdit';
    if (ctx.hasSelection) return 'clearSelection';
    return null;
  }
  if (mod) return null;
  if (ctx.repicking && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) return 'skip';
  const tab = ctx.focusedTab ?? null;
  if (e.key === 'F2' && !e.altKey && !e.shiftKey) return tab !== null && !ctx.tabsLocked ? 'renameTab' : null;
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    if (tab === null || ctx.tabsLocked) return null;
    return e.key === 'ArrowLeft' ? 'moveTabLeft' : 'moveTabRight';
  }
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
  if (e.key === 'Enter' && ctx.hasProposal) return ctx.canConfirm === false ? null : 'confirm';
  if ((e.key === 'l' || e.key === 'L') && ctx.canSetupList && !ctx.hasProposal) return 'setupList';
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
