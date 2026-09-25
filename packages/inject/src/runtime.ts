import {
  HOST_BINDING,
  parseHostMessage,
  scoreFingerprint,
  type HostMessage,
  type PageMessage,
  type Path,
  type ProtocolCandidate,
  type RecorderState,
} from '@webscoop/core/page';
import {
  describeSelection,
  elementAt,
  excerpt,
  isOwn,
  nodeForScore,
  pathOfElement,
  readDocument,
  resolveFirstLocal,
  resolveLocal,
  snapshotOf,
} from './dom';
import type { Overlay } from './overlay';
import type { ObservedAction } from './picker';
import { Store, type Actions, type Toast, type UiState } from './store';
import { handleKey } from './ui/App';

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
      this.apply(parseHostMessage(await fn(msg)));
    } catch (error) {
      this.toast('danger', error instanceof Error ? error.message : String(error));
    }
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
    if (!next.proposal && prev?.proposal) this.store.setUi({ level: 'proposed' });
    // A new item level (an edit, include all) starts from the proposed rung again.
    else if (next.proposal && prev?.proposal && next.proposal.proposed.path.join() !== prev.proposal.proposed.path.join()) this.store.setUi({ level: 'proposed' });
    // Picking a list level opens ready to pick; picking ends when the host clears it.
    if (next.levelPick && !prev?.levelPick && !this.store.get().ui.picking) this.startPicking();
    if (next.repick !== null && prev?.repick === null && !this.store.get().ui.picking) this.startPicking();
    if (next.repickStep !== null && (prev?.repickStep ?? null) === null && !this.store.get().ui.picking) this.startPicking();
    // The focused re-pick mode opens ready to pick.
    if (next.repickContext && !next.repickContext.picked && !prev?.repickContext && !this.store.get().ui.picking) this.startPicking();
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
  };

  cancelPicking = (): void => {
    if (!this.picking) return;
    this.store.setUi({ picking: false });
    this.opts.overlay.setHover(null);
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
      const containers = host.draft.item ? resolveFirstLocal(host.draft.item.selectors, this.doc) : [];
      if (!containers.some((c) => c !== el && el.contains(c))) return 'outside the list';
    }
    if (pick.descendantOf && !strictPrefix(pick.descendantOf, path)) return 'outside the list';
    if (pick.containing && !(strictPrefix(path, pick.containing) || path.join() === pick.containing.join())) return 'does not hold the selection';
    return null;
  }

  hover(el: Element | null): void {
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
      const item = this.store.get().host?.draft.item;
      const containers = item ? resolveFirstLocal(item.selectors, this.doc) : [];
      const { selection, snapshot } = describeSelection(el, containers, this.doc);
      if (newTrail) this.store.setUi({ trail: selection.ancestors, level: 'proposed' });
      this.opts.overlay.setSelected(el);
      await this.send({ kind: 'picker.select', url: this.win.location.href, selection, snapshot });
    });
    this.selecting = run.catch(() => {});
    return run;
  }

  // Overlay -------------------------------------------------------------------

  private excluded(items: readonly Element[], exclude: readonly ProtocolCandidate[]): Element[] {
    if (exclude.length === 0) return [];
    const hits = new Set(exclude.flatMap((c) => resolveLocal(c, undefined, this.doc)));
    return items.filter((el) => hits.has(el));
  }

  /** Draw the selection, the proposal's items, or the confirmed containers. */
  syncOverlay(): void {
    const { host, ui } = this.store.get();
    const overlay = this.opts.overlay;
    const selected = host?.selected ? elementAt(host.selected.selection.path, this.doc) : null;
    overlay.setSelected(selected);
    if (!host || !ui.highlight || host.guardContext) {
      overlay.setList(null);
      return overlay.setItems([], 'sibling');
    }
    overlay.setList(this.listParent());
    if (host.proposal) {
      const level = host.proposal[ui.level] ?? host.proposal.proposed;
      const items = level.paths.map((p) => elementAt(p, this.doc)).filter((e): e is Element => e !== null);
      return overlay.setItems(items, 'sibling', this.excluded(items, host.proposal.exclude));
    }
    if (host.draft.item) {
      const all = resolveFirstLocal(host.draft.item.selectors, this.doc);
      return overlay.setItems(all, 'container', this.excluded(all, host.draft.item.exclude));
    }
    overlay.setItems([], 'sibling');
  }

  /** The list parent to outline: the proposal's, else the confirmed item's first match. */
  private listParent(): Element | null {
    const host = this.store.get().host;
    if (!host) return null;
    if (host.proposal) return host.proposal.within ? elementAt(host.proposal.within.path, this.doc) : null;
    const within = host.draft.item?.within;
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
