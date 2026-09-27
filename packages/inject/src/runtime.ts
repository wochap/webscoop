import {
  currentTable,
  HOST_BINDING,
  parseHostMessage,
  parseSelector,
  scoreFingerprint,
  type HostMessage,
  type PageMessage,
  type Path,
  type ProtocolCandidate,
  type DraftItem,
  type RecorderState,
} from '@webscoop/core/page';
import {
  containersLocal,
  describeSelection,
  elementAt,
  excerpt,
  excludedLocal,
  isOwn,
  nodeForScore,
  pathOfElement,
  readDocument,
  resolveFirstLocal,
  resolveLocal,
  snapshotOf,
} from './dom';
import type { HoverPlace, ListOutlines, Overlay } from './overlay';
import type { ObservedAction } from './picker';
import { Store, type Actions, type Toast, type UiState } from './store';
import { handleKey } from './ui/App';

/** The active table's item container, which picks and highlights work against. */
const activeItem = (host: RecorderState | null | undefined): DraftItem | null => (host ? currentTable(host.draft).item : null);

type HostFn = (msg: unknown) => Promise<unknown>;

export interface RuntimeOptions {
  win: Window;
  store?: Store;
  overlay: Overlay;
  /** Reserve page space for the results drawer. */
  setDrawerSpace?: (open: boolean) => void;
  /** Remove the recorder from the page, when the host detaches. */
  onDetach?: () => void;
  /** Report typing the browse observer holds back, before browse mode ends. */
  flushBrowse?: () => void;
}

const TOAST_MS = { ok: 4000, neutral: 4000, danger: 9000 } as const;

/** The page side of the session: bridges to the host, drives the overlay, and implements the view's actions. */
export class Runtime implements Actions {
  readonly store: Store;
  private toastId = 0;
  private selecting: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RuntimeOptions) {
    this.store = opts.store ?? new Store();
    opts.win.addEventListener('keydown', this.onWindowKey, { capture: true });
  }

  private get win(): Window {
    return this.opts.win;
  }

  private get doc(): Document {
    return this.opts.win.document;
  }

  private hostFn(): HostFn | null {
    const fn = (this.win as unknown as Record<string, unknown>)[HOST_BINDING];
    return typeof fn === 'function' ? (fn as HostFn) : null;
  }

  /** Tell the host the page is ready and take the state it replies with. */
  async start(): Promise<void> {
    await this.send({ kind: 'session.ready', url: this.win.location.href });
  }

  async send(msg: PageMessage): Promise<void> {
    const fn = this.hostFn();
    if (!fn) {
      this.toast('danger', 'webscoop is not connected to this page.');
      return;
    }
    try {
      const before = this.store.get().host?.error;
      const reply = parseHostMessage(await fn(this.withSnapshot(msg)));
      this.apply(reply);
      // The same failure again: state did not change, so setHost stays quiet; say it again.
      if (reply.kind === 'draft.state' && reply.state.error && reply.state.error === before) this.toast('danger', reply.state.error);
    } catch (error) {
      this.toast('danger', error instanceof Error ? error.message : String(error));
    }
  }

  /** Count a selector's matches through the host, without changing any state; null when the host cannot count it. */
  async countSelector(selector: string, scope: 'item' | 'page'): Promise<number | null> {
    const fn = this.hostFn();
    if (!fn) return null;
    try {
      const { strategy, value, stability } = parseSelector(selector);
      const reply = parseHostMessage(await fn({ kind: 'inspect.count', candidate: { strategy, value, stability }, scope }));
      return reply.kind === 'inspect.countResult' ? reply.count : null;
    } catch {
      return null;
    }
  }

  /**
   * The host maps a typed selector's, an edited field's, or the edited item
   * container's first match to a path in the page's own snapshot.
   */
  private withSnapshot(msg: PageMessage): PageMessage {
    if ((msg.kind !== 'selection.setSelector' && msg.kind !== 'draft.editField' && msg.kind !== 'draft.editItem') || msg.snapshot) return msg;
    return { ...msg, snapshot: snapshotOf(readDocument(null, this.doc).root) };
  }

  /** Entry point for `window.__webscoopPage.dispatch`. */
  dispatch(raw: unknown): void {
    try {
      this.apply(parseHostMessage(raw));
    } catch (error) {
      this.toast('danger', error instanceof Error ? error.message : String(error));
    }
  }

  private apply(msg: HostMessage): void {
    switch (msg.kind) {
      case 'draft.state':
        return this.setHost(msg.state);
      case 'test.results':
        this.setHost(msg.state);
        this.setUi({ drawerOpen: true });
        return;
      case 'save.result':
        this.setHost(msg.state);
        if (!msg.ok) this.toast('danger', `Not saved:\n${msg.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
        return;
      case 'inspect.countResult':
        return;
      case 'session.error':
        this.toast('danger', msg.message);
        return;
      case 'step.replayResult':
        this.setHost(msg.state);
        this.toast(msg.ok ? 'ok' : 'danger', msg.message);
        return;
      case 'session.detach':
        this.dispose();
        this.opts.onDetach?.();
        return;
    }
  }

  /** Stop listening to the page. */
  dispose(): void {
    this.opts.win.removeEventListener('keydown', this.onWindowKey, { capture: true });
    this.store.setUi({ picking: false, browsing: false });
  }

  private setHost(next: RecorderState): void {
    const prev = this.store.get().host;
    this.store.setHost(next);
    if (next.error && next.error !== prev?.error) this.toast('danger', next.error);
    if (next.saved && next.saved.at !== prev?.saved?.at) {
      this.toast('ok', `Saved ${next.saved.name}${next.saved.path ? ` to ${next.saved.path}` : ''}`);
    }
    // Picking a list level opens ready to pick; picking ends when the host clears it.
    if (next.levelPick && !prev?.levelPick && !this.store.get().ui.picking) this.startPicking();
    if (next.repick !== null && prev?.repick === null && !this.store.get().ui.picking) this.startPicking();
    if (next.repickStep !== null && (prev?.repickStep ?? null) === null && !this.store.get().ui.picking) this.startPicking();
    // The focused re-pick mode opens ready to pick.
    if (next.repickContext && !next.repickContext.picked && !prev?.repickContext && !this.store.get().ui.picking) this.startPicking();
    // The host asks for a typed selector's or an edited field's element: select it like a pick.
    if (next.pendingSelect && next.pendingSelect.path.join() !== prev?.pendingSelect?.path.join()) {
      const el = elementAt(next.pendingSelect.path, this.doc);
      if (el) void this.select(el, true);
      else this.toast('danger', 'The matched element is no longer on the page.');
    }
    this.syncOverlay();
  }

  setUi(patch: Partial<UiState>): void {
    const before = this.store.get().ui.drawerOpen;
    this.store.setUi(patch);
    const after = this.store.get().ui.drawerOpen;
    if (before !== after) this.opts.setDrawerSpace?.(after);
    this.syncOverlay();
  }

  toast(tone: Toast['tone'], text: string): void {
    const id = ++this.toastId;
    this.store.setUi((ui) => ({ toasts: [...ui.toasts.slice(-3), { id, tone, text }] }));
    this.win.setTimeout(() => this.dismissToast(id), TOAST_MS[tone]);
  }

  dismissToast(id: number): void {
    this.store.setUi((ui) => ({ toasts: ui.toasts.filter((t) => t.id !== id) }));
  }

  // Picking -------------------------------------------------------------------

  get picking(): boolean {
    return this.store.get().ui.picking;
  }

  startPicking = (): void => {
    if (this.browsing) this.stopBrowsing();
    this.store.setUi({ picking: true, menu: null });
    this.opts.overlay.setHover(null);
    this.syncOverlay();
  };

  cancelPicking = (): void => {
    if (!this.picking) return;
    this.store.setUi({ picking: false });
    this.opts.overlay.setHover(null);
    this.syncOverlay();
    void this.send({ kind: 'picker.cancel' });
  };

  // Browsing -------------------------------------------------------------------

  get browsing(): boolean {
    return this.store.get().ui.browsing;
  }

  startBrowsing = (): void => {
    if (this.picking) this.cancelPicking();
    this.store.setUi({ browsing: true, menu: null });
  };

  stopBrowsing = (): void => {
    if (!this.browsing) return;
    this.opts.flushBrowse?.();
    this.store.setUi({ browsing: false });
  };

  /**
   * The user acted on the page while browsing: send the step at once, in the
   * same task as the event, so a navigation the action starts cannot drop it.
   */
  record(action: ObservedAction): void {
    const { selection } = describeSelection(action.el, [], this.doc);
    const candidates = selection.candidates.map((c) => ({ ...c, count: resolveLocal(c, undefined, this.doc).length }));
    void this.send({
      kind: 'draft.addStep',
      step: { kind: action.kind, ...('value' in action ? { value: action.value } : {}) },
      selection: { ...selection, candidates },
    });
  }

  /**
   * Why an element cannot be picked for the list level being picked, or null
   * when it can: the list parent must hold the item, the item must sit inside
   * the list parent and hold the original selection.
   */
  levelRefusal(el: Element): string | null {
    const host = this.store.get().host;
    const pick = host?.levelPick;
    if (!pick) return null;
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return 'outside the list';
    const path = pathOfElement(el);
    const strictPrefix = (a: readonly number[], b: readonly number[]) => a.length < b.length && a.every((v, i) => b[i] === v);
    if (pick.ancestorOf.length > 0 && !pick.ancestorOf.some((p) => strictPrefix(path, p))) return 'outside the list';
    if (pick.ofContainers) {
      const item = activeItem(host);
      const containers = item ? containersLocal(item, this.doc) : [];
      if (!containers.some((c) => c !== el && el.contains(c))) return 'outside the list';
    }
    if (pick.descendantOf && !strictPrefix(pick.descendantOf, path)) return 'outside the list';
    if (pick.containing && !(strictPrefix(path, pick.containing) || path.join() === pick.containing.join())) return 'does not hold the selection';
    return null;
  }

  /**
   * While picking a field in a list table (not a list level, not in the list
   * setup, not re-picking): its containers, list parent, and the other
   * lists' containers, for the outlines and the hover tag.
   */
  private listPicking(): { name: string; parent: Element | null; items: Element[]; others: ListOutlines['others'] } | null {
    const { host, ui } = this.store.get();
    if (!ui.picking || !host || host.levelPick || host.proposal || host.repickContext || host.repick !== null || host.repickStep !== null) return null;
    const table = currentTable(host.draft);
    if (!table.item) return null;
    const items = containersLocal(table.item, this.doc);
    const within = table.item.within;
    const parent = within ? (resolveFirstLocal(within, this.doc)[0] ?? null) : null;
    const others = host.otherLists.map((o) => ({
      table: host.draft.tables[o.table]?.name ?? '',
      items: o.paths.map((p) => elementAt(p, this.doc)).filter((e): e is Element => e !== null),
    }));
    return { name: table.name, parent, items, others };
  }

  /** Outline the element at a path (a hovered ladder row), or clear it. */
  previewPath = (path: Path | null): void => {
    const el = path ? elementAt(path, this.doc) : null;
    this.opts.overlay.setHover(el, el ? excerpt(el) : '');
  };

  hover(el: Element | null): void {
    const lists = el ? this.listPicking() : null;
    if (lists && el) {
      const index = lists.items.findIndex((c) => c === el || c.contains(el));
      const place: HoverPlace = index === -1 ? { kind: 'outside', table: lists.name } : { kind: 'item', index, of: lists.items.length };
      this.opts.overlay.setHover(el, excerpt(el), undefined, undefined, place);
      return;
    }
    if (this.store.get().host?.levelPick) {
      const refused = el ? this.levelRefusal(el) : null;
      this.opts.overlay.setHover(el, el ? excerpt(el) : '', undefined, refused ?? undefined);
      return;
    }
    const ctx = this.store.get().host?.repickContext;
    if (!ctx?.fingerprint) {
      this.opts.overlay.setHover(el, el ? excerpt(el) : '');
      return;
    }
    const score = el ? scoreFingerprint(ctx.fingerprint, nodeForScore(el)) : null;
    this.opts.overlay.setHover(el, el ? excerpt(el) : '', score === null ? undefined : { value: score, likely: score >= ctx.threshold });
    this.store.setUi({ hoverScore: score });
  }

  /** The user clicked an element while picking. */
  pick(el: Element): void {
    const host = this.store.get().host;
    if (host?.levelPick) {
      // Out of range: the click is ignored and picking goes on; the hover tag says why.
      if (this.levelRefusal(el)) return;
      this.store.setUi({ picking: false });
      this.opts.overlay.setHover(null);
      const { level } = host.levelPick;
      // Without a proposal the host has no snapshot of this page yet: send one.
      const snapshot = host.proposal ? undefined : snapshotOf(readDocument(el, this.doc).root);
      void this.send({ kind: 'draft.setLevel', level, by: 'pick', path: pathOfElement(el), ...(snapshot ? { snapshot } : {}) });
      return;
    }
    this.store.setUi({ picking: false });
    this.opts.overlay.setHover(null);
    void this.select(el, true);
  }

  selectPath = (path: Path): void => {
    const el = elementAt(path, this.doc);
    if (el) void this.select(el, false);
  };

  private select(el: Element, newTrail: boolean): Promise<void> {
    const run = this.selecting.then(async () => {
      const item = activeItem(this.store.get().host);
      const containers = item ? containersLocal(item, this.doc) : [];
      const { selection, snapshot } = describeSelection(el, containers, this.doc);
      if (newTrail) this.store.setUi({ trail: selection.ancestors });
      this.opts.overlay.setSelected(el);
      await this.send({ kind: 'picker.select', url: this.win.location.href, selection, snapshot });
    });
    this.selecting = run.catch(() => {});
    return run;
  }

  // Overlay -------------------------------------------------------------------

  private excluded(items: readonly Element[], exclude: readonly ProtocolCandidate[]): Element[] {
    if (exclude.length === 0) return [];
    const hits = excludedLocal(exclude, this.doc);
    return items.filter((el) => hits.has(el));
  }

  /** Draw the selection, the proposal's items, or the confirmed containers. */
  syncOverlay(): void {
    const { host } = this.store.get();
    const overlay = this.opts.overlay;
    const selected = host?.selected ? elementAt(host.selected.selection.path, this.doc) : null;
    overlay.setSelected(selected);
    const lists = this.listPicking();
    overlay.setOutlines(lists && { table: lists.name, parent: lists.parent, items: lists.items, others: lists.others });
    if (!host || host.guardContext) {
      overlay.setList(null);
      overlay.setMatches([]);
      return overlay.setItems([], 'sibling');
    }
    overlay.setMatches(this.editedMatches());
    // While picking in a list, the list parent has its level outline instead.
    overlay.setList(lists ? null : this.listParent());
    if (host.proposal) {
      const items = host.proposal.proposed.paths.map((p) => elementAt(p, this.doc)).filter((e): e is Element => e !== null);
      return overlay.setItems(items, 'sibling', this.excluded(items, host.proposal.exclude));
    }
    const item = activeItem(host);
    if (item) {
      const all = containersLocal(item, this.doc, { keepExcluded: true });
      return overlay.setItems(all, 'container', this.excluded(all, item.exclude));
    }
    overlay.setItems([], 'sibling');
  }

  /** Every match of the edited field's primary candidate: inside each item container for item scope, else on the page. */
  private editedMatches(): Element[] {
    const host = this.store.get().host;
    const editing = host?.editing;
    if (!host || !editing) return [];
    const selected = host.selected;
    const primary = selected ? selected.selection.candidates[selected.primary] : editing.candidates[editing.primary];
    if (!primary) return [];
    const scope = selected?.scope ?? editing.options.scope;
    if (scope === 'page') return resolveLocal(primary, undefined, this.doc);
    const item = activeItem(host);
    const containers = item ? containersLocal(item, this.doc) : [];
    return containers.flatMap((c) => resolveLocal(primary, c, this.doc));
  }

  /** The list parent to outline: the proposal's, else the confirmed item's first match. */
  private listParent(): Element | null {
    const host = this.store.get().host;
    if (!host) return null;
    if (host.proposal) return host.proposal.within ? elementAt(host.proposal.within.path, this.doc) : null;
    const within = activeItem(host)?.within;
    return within ? (resolveFirstLocal(within, this.doc)[0] ?? null) : null;
  }

  // Keyboard ------------------------------------------------------------------

  /** Shortcuts pressed while focus is on the page; the panel handles its own keys. */
  private readonly onWindowKey = (e: KeyboardEvent): void => {
    if (isOwn(e.target as Node)) return;
    if (handleKey(e, e.target, this.store.get(), this)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
}
