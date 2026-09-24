import type { Crumb, PageMessage, Path, RecorderState } from '@webscoop/core/page';

export type Mode = 'idle' | 'picking' | 'selected' | 'items' | 'editing' | 'test';

export interface Toast {
  id: number;
  tone: 'ok' | 'danger' | 'neutral';
  text: string;
}

export interface UiState {
  picking: boolean;
  /** Breadcrumb of the element originally picked, so Right can walk back down. */
  trail: Crumb[];
  /** Field row that has keyboard focus, for Alt+Up and Alt+Down. */
  focusedField: number | null;
  /** Open menu id (for example a type select); Esc closes it. */
  menu: string | null;
  drawerOpen: boolean;
  drawerView: 'table' | 'json';
  editingVar: string | null;
  /** Container level chosen in the item proposal. */
  level: 'proposed' | 'broader' | 'narrower';
  /** Whether item matches are highlighted on the page. */
  highlight: boolean;
  toasts: Toast[];
}

export const initialUi: UiState = {
  picking: false,
  trail: [],
  focusedField: null,
  menu: null,
  drawerOpen: false,
  drawerView: 'table',
  editingVar: null,
  level: 'proposed',
  highlight: true,
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
  if (ui.picking) return 'picking';
  if (ui.drawerOpen && host?.test) return 'test';
  if (host?.proposal) return 'items';
  if (host?.selected) return 'selected';
  if (ui.focusedField !== null || (host?.repick ?? null) !== null) return 'editing';
  return 'idle';
}

/** What the view can ask the page runtime to do. */
export interface Actions {
  send(msg: PageMessage): Promise<void>;
  startPicking(): void;
  cancelPicking(): void;
  /** Select the element at a path, keeping the original breadcrumb trail. */
  selectPath(path: Path): void;
  setUi(patch: Partial<UiState>): void;
  toast(tone: Toast['tone'], text: string): void;
  dismissToast(id: number): void;
}
