import type { Crumb, PageMessage, Path, RecorderState } from '@webscoop/core/page';

export type Mode = 'idle' | 'picking' | 'browsing' | 'repick' | 'guard' | 'selected' | 'items' | 'editing' | 'test';

export interface Toast {
  id: number;
  tone: 'ok' | 'danger' | 'neutral';
  text: string;
}

export interface UiState {
  picking: boolean;
  /** Browse mode: the page works normally and clicks, typing, and key presses are recorded as steps. */
  browsing: boolean;
  /** Breadcrumb of the element originally picked, so Right can walk back down. */
  trail: Crumb[];
  /** Field row that has keyboard focus, for Alt+Up and Alt+Down. */
  focusedField: number | null;
  /** Step row that has keyboard focus, for Alt+Up and Alt+Down. */
  focusedStep: number | null;
  /** Table tab that has keyboard focus, for Alt+Left, Alt+Right, and F2. */
  focusedTab: number | null;
  /** Table tab being renamed inline. */
  renamingTab: number | null;
  /** Open menu id (for example a type select); Esc closes it. */
  menu: string | null;
  drawerOpen: boolean;
  drawerView: 'table' | 'json';
  editingVar: string | null;
  /** Fingerprint score of the hovered element while re-picking, null when nothing is hovered. */
  hoverScore: number | null;
  /** While picking: the hover walk distance, the similar sibling count, and the labels from the hover target down to the start element. */
  hover: HoverInfo | null;
  toasts: Toast[];
}

export interface HoverInfo {
  depth: number;
  similar: number;
  /** Compact labels from the walked target down to the element under the pointer (the last one). */
  path: string[];
}

export const initialUi: UiState = {
  picking: false,
  browsing: false,
  trail: [],
  focusedField: null,
  focusedStep: null,
  focusedTab: null,
  renamingTab: null,
  menu: null,
  drawerOpen: false,
  drawerView: 'table',
  editingVar: null,
  hoverScore: null,
  hover: null,
  toasts: [],
};

export interface Snapshot {
  host: RecorderState | null;
  ui: UiState;
}

/** A tiny external store for `useSyncExternalStore`. */
export class Store {
  private snapshot: Snapshot = { host: null, ui: initialUi };
  private readonly listeners = new Set<() => void>();

  get = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setHost(host: RecorderState): void {
    this.snapshot = { ...this.snapshot, host };
    this.emit();
  }

  setUi(patch: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void {
    const next = typeof patch === 'function' ? patch(this.snapshot.ui) : patch;
    this.snapshot = { ...this.snapshot, ui: { ...this.snapshot.ui, ...next } };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The panel mode shown in the header pill. */
export function modeOf({ host, ui }: Snapshot): Mode {
  if (host?.guardContext) return 'guard';
  if (ui.picking) return 'picking';
  if (ui.browsing) return 'browsing';
  if (host?.repickContext) return 'repick';
  if (ui.drawerOpen && host?.test) return 'test';
  if (host?.proposal) return host.proposal.origin === 'edit' ? 'editing' : 'items';
  if (host?.editing) return 'editing';
  if (host?.selected) return 'selected';
  if (ui.focusedField !== null || ui.focusedStep !== null || (host?.repick ?? null) !== null || (host?.repickStep ?? null) !== null) return 'editing';
  return 'idle';
}

/** What the view can ask the page runtime to do. */
export interface Actions {
  send(msg: PageMessage): Promise<void>;
  /** Count the matches of `strategy=value` text on the page or inside the item containers; null when it cannot be counted. */
  countSelector?(selector: string, scope: 'item' | 'page'): Promise<number | null>;
  startPicking(): void;
  cancelPicking(): void;
  /** Turn browse mode on or off. */
  startBrowsing(): void;
  stopBrowsing(): void;
  /** Select the element at a path, keeping the original breadcrumb trail. */
  selectPath(path: Path): void;
  /** Outline the element at a path on the page while a ladder row is hovered; null clears it. */
  previewPath?(path: Path | null): void;
  setUi(patch: Partial<UiState>): void;
  toast(tone: Toast['tone'], text: string): void;
  dismissToast(id: number): void;
}
