import { createPendingSelectors } from './pending';
import { mergeNetwork, type NetworkFilter } from './network';
import type { BlockPath, Crumb, NetworkEntry, PageMessage, PanelMode, Path, RecorderState, TargetRef } from '@webscoop/core/page';

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
  /** Step row that has keyboard focus, for Alt+Up and Alt+Down: its flow and index. */
  focusedStep: StepRef | null;
  /** Step open in its edit state. */
  editingStep: StepRef | null;
  /** Sequence block that has keyboard focus, for Alt+Up and Alt+Down. */
  focusedBlock: BlockPath | null;
  /** The Alt+F flow switcher is open. */
  switcher: boolean;
  /** Flows expanded besides the active one, by name. */
  openFlows: string[];
  /** The paginate block's settings are expanded. */
  paginateOpen: boolean;
  /** How this window shows the panel, as the host last said. */
  panelMode: PanelMode;
  /** This window is a popup of the session. */
  popup: boolean;
  /** The window is narrower than 640 pixels: the owner shows the compact bar. */
  narrow: boolean;
  /** The compact bar's sheet is open: the panel sheet, or the network picker alone (`network`). */
  sheet: boolean | 'network';
  /** The Network picker is open in the Captures section. */
  picker: boolean;
  /** The picker's filter chip and filter text. */
  networkFilter: NetworkFilter;
  networkQuery: string;
  /** The capture editor: a new capture from a picked request, or a saved capture by index. */
  captureEditor: CaptureEditorState | null;
  /** Captures whose matched URLs are expanded, by name. */
  openCaptures: string[];
  /** A recipe without tables shows the tab bar anyway, after "Add a table". */
  showTables: boolean;
  /** Table tab that has keyboard focus, for Alt+Left, Alt+Right, and F2. */
  focusedTab: number | null;
  /** Table tab being renamed inline. */
  renamingTab: number | null;
  /** Open menu id (for example a type select); Esc closes it. */
  menu: string | null;
  drawerOpen: boolean;
  drawerView: 'table' | 'json';
  /** Fingerprint score of the hovered element while re-picking, null when nothing is hovered. */
  hoverScore: number | null;
  /** While picking: the hover walk distance, the similar sibling count, and the labels from the hover target down to the start element. */
  hover: HoverInfo | null;
  /** The frame target open in the frame editor, by its primary candidate (`strategy=value`). */
  frameEdit: string | null;
  /** Counts page picks whose host reply has landed; panel-driven selection changes leave it alone. */
  pickSeq: number;
  toasts: Toast[];
}

export type CaptureEditorState = { mode: 'new'; url: string; frame: string | null; stream: boolean } | { mode: 'edit'; index: number };

/** A step by its flow index and its index in that flow. */
export interface StepRef {
  flow: number;
  index: number;
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
  editingStep: null,
  focusedBlock: null,
  switcher: false,
  openFlows: [],
  paginateOpen: false,
  panelMode: 'owner',
  popup: false,
  narrow: false,
  sheet: false,
  picker: false,
  networkFilter: 'media',
  networkQuery: '',
  captureEditor: null,
  openCaptures: [],
  showTables: false,
  focusedTab: null,
  renamingTab: null,
  menu: null,
  drawerOpen: false,
  drawerView: 'table',
  hoverScore: null,
  hover: null,
  frameEdit: null,
  pickSeq: 0,
  toasts: [],
};

export interface Snapshot {
  host: RecorderState | null;
  ui: UiState;
  /** The session's request log, oldest first, as the host sent it. */
  network: NetworkEntry[];
}

/** A tiny external store for `useSyncExternalStore`. */
export class Store {
  private snapshot: Snapshot = { host: null, ui: initialUi, network: [] };
  private readonly listeners = new Set<() => void>();
  /** Selector inputs with pending text, applied by the closers of their editors. */
  readonly pending = createPendingSelectors();

  get = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setHost(host: RecorderState): void {
    this.snapshot = { ...this.snapshot, host };
    this.emit();
  }

  /** Merge a batch of the host's request log; `reset` replaces the log. */
  setNetwork(entries: readonly NetworkEntry[], reset: boolean): void {
    this.snapshot = { ...this.snapshot, network: mergeNetwork(this.snapshot.network, entries, reset) };
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
  if (ui.focusedField !== null || ui.editingStep !== null || (host?.repick ?? null) !== null || (host?.targetEdit ?? null) !== null) return 'editing';
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
  /** Count typed selector text for a target edit in the target's window and frame; null when it cannot be counted. */
  countTarget?(ref: TargetRef, selector: string): Promise<{ count: number; error: string | null } | null>;
  /** Outline the first match of typed selector text with the match highlight; null clears it. */
  previewSelector?(selector: string | null): void;
  /** Outline the element at a path on the page while a ladder row is hovered; null clears it. */
  previewPath?(path: Path | null): void;
  setUi(patch: Partial<UiState>): void;
  toast(tone: Toast['tone'], text: string): void;
  dismissToast(id: number): void;
}
