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
  | 'moveBlockUp'
  | 'moveBlockDown'
  | 'switcher'
  | 'closeSwitcher'
  | 'chooseFlow1'
  | 'chooseFlow2'
  | 'chooseFlow3'
  | 'chooseFlow4'
  | 'chooseFlow5'
  | 'chooseFlow6'
  | 'chooseFlow7'
  | 'chooseFlow8'
  | 'chooseFlow9'
  | 'closeSheet'
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
  | 'cancelRename'
  | 'useTarget';

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
  /** Whether a step row has keyboard focus, for Alt+Up and Alt+Down. */
  focusedStep?: unknown;
  /** Whether a sequence block has keyboard focus, for Alt+Up and Alt+Down. */
  focusedBlock?: unknown;
  /** The flow switcher is open: digits choose a flow, Esc closes it. */
  switcher?: boolean;
  /** The compact bar's sheet is open: Esc closes it. */
  sheet?: boolean;
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
  /** The re-pick details show a selection: Enter applies "Use for …". */
  canUseTarget?: boolean;
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

/** Whether the event target is inside an open panel menu (a dropdown listbox), which handles its own keys. */
export function isMenuTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && typeof el.closest === 'function' && el.closest('[role="listbox"]'));
}

/**
 * Map a key press to a panel shortcut: `p` picks, `b` toggles browse mode,
 * `L` opens the list setup from the list suggestion, Esc closes a menu,
 * cancels a tab rename, cancels picking, closes the list setup, leaves browse
 * mode, aborts a re-pick, cancels a field edit, or clears the selection, the
 * first that applies; Enter accepts the list setup while its item matches
 * something or applies the re-pick selection ("Use for …"), Left and Right walk the breadcrumb, Alt+Up and Alt+Down
 * reorder the focused field, step, or sequence block, Alt+Left and Alt+Right
 * move the focused table tab, F2 renames it, Alt+F opens the flow switcher
 * (digits 1 to 9 choose a flow there), Ctrl+S saves.
 * While re-picking, `s` skips the field and Esc (when not picking) aborts.
 * While picking, only Esc and Ctrl+S act here; the picker handles the hover
 * walk keys (Up and Down, `[` and `]`) itself. Nothing fires while typing.
 */
export function shortcutFor(e: KeyLike, ctx: ShortcutContext): Shortcut | null {
  if (ctx.typing) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 's') return 'save';
  if (ctx.switcher && !mod && !e.altKey && /^[1-9]$/.test(e.key)) return `chooseFlow${e.key}` as Shortcut;
  if (e.key === 'Escape') {
    if (ctx.switcher) return 'closeSwitcher';
    if (ctx.menuOpen) return 'closeMenu';
    if (ctx.renaming) return 'cancelRename';
    if (ctx.picking) return 'cancel';
    if (ctx.hasProposal) return 'closeSetup';
    if (ctx.browsing) return 'stopBrowse';
    if (ctx.repicking) return 'abort';
    if (ctx.editing) return 'cancelEdit';
    if (ctx.hasSelection) return 'clearSelection';
    if (ctx.sheet) return 'closeSheet';
    return null;
  }
  if (e.altKey && !mod && (e.key === 'f' || e.key === 'F')) return ctx.picking ? null : 'switcher';
  if (ctx.picking || mod) return null;
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
    if (ctx.focusedBlock !== undefined && ctx.focusedBlock !== null) return up ? 'moveBlockUp' : 'moveBlockDown';
    if (ctx.focusedField === null) return null;
    return up ? 'moveUp' : 'moveDown';
  }
  if (e.shiftKey) return null;
  if (e.key === 'p' || e.key === 'P') return 'pick';
  if ((e.key === 'b' || e.key === 'B') && !ctx.repicking) return ctx.browsing ? 'stopBrowse' : 'browse';
  if (e.key === 'Enter' && ctx.hasProposal) return ctx.canConfirm === false ? null : 'confirm';
  if (e.key === 'Enter' && ctx.canUseTarget) return 'useTarget';
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
