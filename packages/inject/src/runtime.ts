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
  compactLabel,
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
  similarSiblings,
  snapshotOf,
} from './dom';
import type { HoverPlace, HoverWalkInfo, ListOutlines, Overlay } from './overlay';
import { walkChain, type HoverWalk, type ObservedAction } from './picker';
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
/** Longest wait for the host binding before the page reports that it is not connected. */
const BINDING_WAIT_MS = 5000;

export class Runtime implements Actions {
  readonly store: Store;
  private toastId = 0;
  private selecting: Promise<void> = Promise.resolve();
  /** Similar sibling counts of hover targets, per picking session. */
  private similar = new WeakMap<Element, number>();
  /** The hover target and walk depth the panel's hovering card shows. */
  private hovered: { el: Element | null; depth: number } = { el: null, depth: 0 };

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
    // Some drivers install the binding a moment after the document loads.
    for (let waited = 0; !this.hostFn() && waited < BINDING_WAIT_MS; waited += 50) await new Promise((r) => setTimeout(r, 50));
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
    this.similar = new WeakMap();
    this.store.setUi({ picking: true, menu: null });
    this.clearHover();
    this.opts.overlay.setStrip(this.stripTitle());
    this.syncOverlay();
  };

  cancelPicking = (): void => {
    if (!this.picking) return;
    this.store.setUi({ picking: false });
    this.clearHover();
    this.opts.overlay.setStrip(null);
    this.syncOverlay();
    void this.send({ kind: 'picker.cancel' });
  };

  /** "Picking", or "Picking in <table>" when the active table is a list. */
  private stripTitle(): string {
    const host = this.store.get().host;
    const table = host ? currentTable(host.draft) : null;
    return table?.item ? `Picking in ${table.name}` : 'Picking';
  }

  private clearHover(): void {
    this.opts.overlay.setHover(null);
    this.hovered = { el: null, depth: 0 };
    if (this.store.get().ui.hover !== null) this.store.setUi({ hover: null });
  }

  /** A key aimed at the page while picking: the picker holds it back, the panel shortcuts (Ctrl+S) may still run. */
  pageKey = (e: KeyboardEvent): void => {
    if (handleKey(e, e.target, this.store.get(), this)) e.preventDefault();
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

  /** The hover walk parts for the tag and the panel: distance, similar siblings (memoized), and size. */
  private walkInfo(el: Element, walk: HoverWalk | undefined): HoverWalkInfo {
    let similar = this.similar.get(el);
    if (similar === undefined) this.similar.set(el, (similar = similarSiblings(el)));
    const r = el.getBoundingClientRect();
    return { start: walk?.start ?? el, depth: walk?.depth ?? 0, similar, size: { w: Math.round(r.width), h: Math.round(r.height) } };
  }

  /** Update the hovering card when the target or the walk depth changed. */
  private setHoverCard(el: Element | null, info: HoverWalkInfo | undefined): void {
    const depth = info?.depth ?? 0;
    if (this.hovered.el === el && this.hovered.depth === depth) return;
    this.hovered = { el, depth };
    if (!el || !info || !this.picking) {
      if (this.store.get().ui.hover !== null) this.store.setUi({ hover: null });
      return;
    }
    const chain = walkChain(info.start).slice(0, depth + 1).reverse();
    this.store.setUi({ hover: { depth, similar: info.similar, path: chain.map(compactLabel) } });
  }

  /** The hover target changed, pointed at or walked to: the same refusal, list place, and re-pick score apply. */
  hover(el: Element | null, walk?: HoverWalk): void {
    const info = el ? this.walkInfo(el, walk) : undefined;
    this.setHoverCard(el, info);
    const lists = el ? this.listPicking() : null;
    if (lists && el) {
      const index = lists.items.findIndex((c) => c === el || c.contains(el));
      const place: HoverPlace = index === -1 ? { kind: 'outside', table: lists.name } : { kind: 'item', index, of: lists.items.length };
      this.opts.overlay.setHover(el, excerpt(el), undefined, undefined, place, info);
      return;
    }
    if (this.store.get().host?.levelPick) {
      const refused = el ? this.levelRefusal(el) : null;
      this.opts.overlay.setHover(el, el ? excerpt(el) : '', undefined, refused ?? undefined, undefined, info);
      return;
    }
    const ctx = this.store.get().host?.repickContext;
    if (!ctx?.fingerprint) {
      this.opts.overlay.setHover(el, el ? excerpt(el) : '', undefined, undefined, undefined, info);
      return;
    }
    const score = el ? scoreFingerprint(ctx.fingerprint, nodeForScore(el)) : null;
    this.opts.overlay.setHover(el, el ? excerpt(el) : '', score === null ? undefined : { value: score, likely: score >= ctx.threshold }, undefined, undefined, info);
    this.store.setUi({ hoverScore: score });
  }

  /** The user clicked an element while picking. */
  pick(el: Element): void {
    const host = this.store.get().host;
    if (host?.levelPick) {
      // Out of range: the click is ignored and picking goes on; the hover tag says why.
      if (this.levelRefusal(el)) return;
      this.store.setUi({ picking: false });
      this.clearHover();
      this.opts.overlay.setStrip(null);
      const { level } = host.levelPick;
      // Without a proposal the host has no snapshot of this page yet: send one.
      const snapshot = host.proposal ? undefined : snapshotOf(readDocument(el, this.doc).root);
      void this.send({ kind: 'draft.setLevel', level, by: 'pick', path: pathOfElement(el), ...(snapshot ? { snapshot } : {}) });
      return;
    }
    this.store.setUi({ picking: false });
    this.clearHover();
    this.opts.overlay.setStrip(null);
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
    overlay.setStrip(this.picking ? this.stripTitle() : null);
    const lists = this.listPicking();
    overlay.setOutlines(lists && { table: lists.name, parent: lists.parent, items: lists.items, others: lists.others });
    if (!host || host.guardContext) {
      overlay.setList(null);
      overlay.setMatches([]);
      return overlay.setItems([], 'sibling');
    }
    overlay.setMatches(this.selectionMatches());
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

  /**
   * The match highlight: every match of the edited field's primary candidate
   * (inside each item container for item scope, else on the page); else the
   * pick's relative candidate inside each proposed item while the list setup
   * is open; else the item scoped selection's primary inside each container.
   */
  private selectionMatches(): Element[] {
    const host = this.store.get().host;
    if (!host) return [];
    const selected = host.selected;
    const editing = host.editing;
    if (editing) {
      const primary = selected ? selected.selection.candidates[selected.primary] : editing.candidates[editing.primary];
      if (!primary) return [];
      const scope = selected?.scope ?? editing.options.scope;
      if (scope === 'page') return resolveLocal(primary, undefined, this.doc);
      const item = activeItem(host);
      const containers = item ? containersLocal(item, this.doc) : [];
      return containers.flatMap((c) => resolveLocal(primary, c, this.doc));
    }
    const own = selected ? elementAt(selected.selection.path, this.doc) : null;
    if (host.proposal) {
      const candidate = host.proposal.pick?.selector;
      if (!candidate) return [];
      const all = host.proposal.proposed.paths.map((p) => elementAt(p, this.doc)).filter((e): e is Element => e !== null);
      const excluded = new Set(this.excluded(all, host.proposal.exclude));
      const items = all.filter((el) => !excluded.has(el));
      // A pick that is itself an item container has no item relative match.
      if (own && items.includes(own)) return [];
      return items.flatMap((c) => resolveLocal(candidate, c, this.doc));
    }
    if (!selected || selected.scope !== 'item') return [];
    const item = activeItem(host);
    const primary = selected.selection.candidates[selected.primary];
    if (!item || !primary) return [];
    const containers = containersLocal(item, this.doc);
    if (own && containers.includes(own)) return [];
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
