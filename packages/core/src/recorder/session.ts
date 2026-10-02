import { convertValue, defaultAttr } from '../convert';
import { containersFor, excludeContainers, extractPage, listParent, resolveFirst } from '../extract';
import { MAIN_WINDOW, type ElementRef, type FilePort, type InteractiveSession, type PageInfo, type RecorderWindow, type SerializedElement, type StoragePort } from '../ports';
import { scoreFingerprint } from '../healing/score';
import type { FieldScope, FieldType, Fingerprint, Flow, SelectorCandidate } from '../recipe/schema';
import { DESCRIPTION_MAX } from '../recipe/constants';
import { tablesOf } from '../recipe/tables';
import { validateRecipe } from '../recipe/validate';
import { runFlow, splitPaths, type StepReport } from '../flows/replay';
import { RunWindows } from '../flows/windows';
import {
  annotate,
  compoundOf,
  descendantsOf,
  elementChildren,
  fingerprint,
  generate,
  inferItems,
  nodeAt,
  normalize,
  parseSelector,
  pathOf,
  rank,
  refForNode,
  relativize,
  similarity,
  SIMILARITY_THRESHOLD,
  textContent,
  type AnnotatedNode,
  type Candidate,
  type ItemLevel,
  type ItemProposal,
} from '../selectors';
import { fillTemplate, retemplateUrl, templateProblem } from '../template';
import {
  bare,
  defaultFlowName,
  detectPagination,
  draftSequence,
  flowNameError,
  newPagination,
  draftErrors,
  draftToRecipe,
  defaultTableName,
  fieldDefaults,
  tableNameError,
  reduceDraft,
  varNameError,
  type DraftAction,
} from './draft';
import { RecorderEmitter } from './events';
import {
  currentTable,
  descriptionKey,
  flowsBefore,
  frameLabel,
  HOST_BINDING,
  sameFrame,
  parsePageMessage,
  scopeForTable,
  tableMode,
  type DraftItem,
  type DraftTable,
  type Draft,
  type FieldPatch,
  type FrameTarget,
  type HostMessage,
  type ItemLadderRow,
  type LevelView,
  type NewStep,
  type ParentLadderRow,
  type ProposalOrigin,
  type ParsedPageMessage,
  type ParsedSelection,
  type ProposalView,
  type ProtocolCandidate,
  type GuardContextView,
  type LevelKind,
  type LevelPick,
  type RecorderState,
  type SelectedView,
  type RepickContext,
  type TestResults,
  type TestTable,
} from './protocol';

/**
 * `full` records a whole recipe; `repick` focuses on replacing one field's
 * selectors; `guard` only shows the guard banner while a run waits for a human.
 */
export type RecorderMode =
  | { kind: 'full' }
  | { kind: 'repick'; fieldIndex: number; reason: 'run' | 'cli'; sample?: string | null; /** Table holding the field; default the first. */ table?: string }
  | { kind: 'guard' };

/** Hooks for the guard banner's buttons. */
export interface GuardHooks {
  onContinue(cb: () => void): void;
  onAbort(cb: () => void): void;
}

/** How a focused re-pick ended. */
export type RepickOutcome =
  | { kind: 'picked'; selectors: SelectorCandidate[]; fingerprint?: Fingerprint }
  | { kind: 'skip' }
  | { kind: 'abort' };

export interface RecorderOptions {
  session: InteractiveSession;
  storage: StoragePort;
  /** The injected recorder bundle. */
  bundle: string;
  /** Starting draft: empty for a new recipe, loaded for `--edit`. */
  draft: Draft;
  emitter?: RecorderEmitter;
  /** Navigation timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Where the storage writes a recipe, for messages. */
  pathFor?: (name: string) => string;
  now?: () => Date;
  /** Default `full`. */
  mode?: RecorderMode;
  /** Whether the user closing the window aborts a waiting guard. Default true; false for a popup that closes itself. */
  abortOnClose?: boolean;
  /** Host files, to check the paths of path variables. Without it every path reads as missing. */
  files?: FilePort;
}

/** A one-line toast for a step or flow replay. */
function describeReplay(flow: string, index: number | null, reports: readonly StepReport[]): string {
  if (index !== null) {
    const report = reports[0];
    const ok = report?.outcome === 'ok' || report?.outcome === 'healed';
    return ok ? `replayed step ${index + 1} (${report!.kind})` : `skipped step ${index + 1}: ${report?.notes?.join('; ') ?? 'found no element'}`;
  }
  const skipped = reports.filter((r) => r.outcome === 'skipped');
  return skipped.length === 0 ? `replayed flow ${flow} (${reports.length} step${reports.length === 1 ? '' : 's'})` : `replayed flow ${flow}; skipped step${skipped.length === 1 ? '' : 's'} ${skipped.map((r) => r.index + 1).join(', ')}`;
}

/** Rows sent to the panel after a test run; the count is always the full count. */
const MAX_TEST_ROWS = 200;
const TOP = new Set(['html', 'body', 'head']);

/** An item's text for a sample: its separate text parts joined with ` · `, so the panel can tell them apart. */
function sampleOf(node: AnnotatedNode, max = 120): string {
  const parts: string[] = [];
  const walk = (n: AnnotatedNode['children'][number]) => {
    if (n.type === 'text') {
      const text = normalize(n.text);
      if (text && parts.at(-1) !== text) parts.push(text);
    } else if (n.tag !== 'script' && n.tag !== 'style') for (const c of n.children) walk(c);
  };
  walk(node);
  return parts.join(' · ').slice(0, max);
}

function levelLabel(node: AnnotatedNode): string {
  const classes = (node.attrs.class ?? '').split(/\s+/).filter(Boolean);
  return compoundOf(node) || (node.role ?? node.tag) + (classes[0] ? `.${classes[0]}` : '');
}

function dedupe<T extends Candidate>(candidates: readonly T[]): T[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.strategy}=${c.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isInside(node: AnnotatedNode, container: AnnotatedNode): boolean {
  for (let cur: AnnotatedNode | null | undefined = node; cur; cur = cur.parent) if (cur === container) return true;
  return false;
}

/** The nearest element holding every node, excluding the nodes themselves; null when they share none. */
function commonAncestor(nodes: readonly AnnotatedNode[]): AnnotatedNode | null {
  const [first, ...rest] = nodes;
  for (let cur = first?.parent; cur; cur = cur.parent) {
    if (rest.every((n) => n !== cur && isInside(n, cur))) return cur;
  }
  return null;
}

/** Move the candidate at `index` to the front. */
function toFront<T>(list: readonly T[], index: number): T[] {
  const chosen = list[index];
  if (chosen === undefined) throw new Error(`no candidate at index ${index}`);
  return [chosen, ...list.filter((_, i) => i !== index)];
}

const samePath = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => b[i] === v);
const sameSelector = (a: Candidate, b: Candidate) => a.strategy === b.strategy && a.value === b.value;
/** An XPath with step indexes, or CSS with `:nth-child` or `:nth-of-type`. */
const isPositional = (c: Candidate) => (c.strategy === 'xpath' ? /\[\d+\]/.test(c.value) : /:nth-(?:child|of-type)\(/.test(c.value));

/** Primary candidate first, then the rest in ranked order, without candidates that match nothing. */
function orderForSave(candidates: readonly ProtocolCandidate[], primary: number): ProtocolCandidate[] {
  const first = candidates[primary] ?? candidates[0];
  if (!first) return [];
  const rest = candidates.filter((c, i) => i !== primary && c !== first && c.count !== 0);
  return [first, ...rest];
}

/** Most rows in a list setup ladder. */
const MAX_LADDER = 12;
export const LIST_READY = 'List ready — pick fields inside an item';

/** The inferred list the setup works on; a manual setup has no item container yet. */
type WorkingList = Omit<ItemProposal, 'container' | 'broader' | 'narrower'> & { container: AnnotatedNode | null };

/** An item container level with no candidates, for a manual setup. */
const EMPTY_LEVEL: LevelView = { tag: '', label: '', path: [], selectors: [], primary: 0, count: 0, total: 0, paths: [], samples: [] };

/** What the suggestion card shows for an inferred list: at least two items. */
function suggestionOf(proposal: ItemProposal | null): SelectedView['suggestion'] {
  if (!proposal || proposal.siblings.length < 2) return null;
  const count = proposal.siblings.length;
  return { count, samples: proposal.siblings.slice(0, 3).map((n) => sampleOf(n)), more: Math.max(0, count - 3) };
}

/** Descendants of `list` on the same tag path as `item`, with a similar structure. */
function likeItem(list: AnnotatedNode, item: AnnotatedNode): number {
  const tags: string[] = [];
  for (let cur: AnnotatedNode | null | undefined = item; cur && cur !== list; cur = cur.parent) tags.unshift(cur.tag);
  let level = [list];
  for (const tag of tags) level = level.flatMap((n) => elementChildren(n).filter((c) => c.tag === tag));
  return level.filter((n) => n === item || similarity(n, item) >= SIMILARITY_THRESHOLD).length;
}

/**
 * The host side of one recording session: owns the draft recipe, answers the
 * page's messages, verifies every selector count through `Session.resolve`,
 * and runs and saves the draft.
 */
export class RecorderController {
  readonly emitter: RecorderEmitter;
  private current: RecorderState;
  private node: AnnotatedNode | null = null;
  /** Snapshot the last pick came with. */
  private root: AnnotatedNode | null = null;
  private proposal: WorkingList | null = null;
  /** Where the open list setup came from. */
  private origin: ProposalOrigin = 'pick';
  /** Proposal edits that inference does not know about: typed selectors, a cleared list parent, include all. */
  private edits: { within: Candidate | null; item: Candidate | null; withinCleared: boolean; withinInferred: boolean; includeAll: boolean } = {
    within: null,
    item: null,
    withinCleared: false,
    /** The list parent in effect was derived by the recorder, not chosen by the user. */
    withinInferred: false,
    includeAll: false,
  };
  /** A typed selection selector waiting for the page to select its first match. */
  private typed: { candidate: ProtocolCandidate; scope: FieldScope } | null = null;
  /** The edited field's saved candidates, counted, waiting for the page to select the field's element. */
  private editSeed: ProtocolCandidate[] | null = null;
  /** The selected element was chosen by hand (a pick or crumb click), not by a typed selector or an opened edit. */
  private handPicked = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: (() => void)[] = [];
  private closedResolve!: (reason: 'closed' | 'ended') => void;
  private readonly closedPromise: Promise<'closed' | 'ended'>;
  private repickResolve!: (outcome: RepickOutcome) => void;
  private readonly repickPromise: Promise<RepickOutcome>;
  private readonly guardListeners = { continue: new Set<() => void>(), abort: new Set<() => void>() };
  /**
   * The session as host lookups see it: `resolve` and `snapshot` without a
   * scope work in the current frame's document (see `scopeFrame`), so every
   * count, verification, and snapshot follows the iframe being worked on.
   */
  private readonly view: InteractiveSession;
  /** The frame lookups run in while set, instead of the selection's or the active table's. */
  private frameOverride: { frame: FrameTarget | null } | null = null;
  /** The current frame's document root, resolved once per message. */
  private frameMemo: { key: string; root: Promise<ElementRef | null> } | null = null;
  /** Set by `detach`: pages that load afterwards are told to remove the recorder. */
  private detached = false;
  /** Every window of the session: the main window and the popups opened from it, by id. */
  private readonly windows = new Map<string, { session: InteractiveSession; opener: string }>();
  /** The window that owns the panel: picks, browse recording, and lookups happen there. */
  private owner = MAIN_WINDOW;

  constructor(private readonly opts: RecorderOptions) {
    this.emitter = opts.emitter ?? new RecorderEmitter();
    this.windows.set(MAIN_WINDOW, { session: opts.session, opener: MAIN_WINDOW });
    const resolve: InteractiveSession['resolve'] = async (candidate, within) => {
      if (within) return this.raw.resolve(candidate, within);
      const base = await this.frameBase();
      return base === null ? [] : this.raw.resolve(candidate, base);
    };
    const snapshot: InteractiveSession['snapshot'] = async (within) => {
      if (within) return this.raw.snapshot(within);
      const base = await this.frameBase();
      if (base === null) throw new Error(`${frameLabel(this.scopeFrame()!)} is not on the page`);
      return this.raw.snapshot(base);
    };
    // Lookups follow the owner window, which changes when a popup takes the panel.
    this.view = new Proxy(opts.session, {
      get: (_target, prop) => {
        if (prop === 'resolve') return resolve;
        if (prop === 'snapshot') return snapshot;
        const target = this.raw;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const mode = opts.mode ?? { kind: 'full' };
    let repickContext: RepickContext | null = null;
    let draft = opts.draft;
    if (mode.kind === 'repick') {
      const tableIndex = mode.table === undefined ? 0 : draft.tables.findIndex((t) => t.name === mode.table);
      if (tableIndex === -1) throw new Error(`no table named ${mode.table}`);
      // The re-picked field's table is active while the re-pick lasts.
      draft = { ...draft, activeTable: tableIndex };
      const table = draft.tables[tableIndex]!;
      const field = table.fields[mode.fieldIndex];
      if (!field) throw new Error(`no field at index ${mode.fieldIndex}`);
      repickContext = {
        table: table.name,
        field: field.name,
        index: mode.fieldIndex,
        oldSelector: bare(field.selectors[0]!),
        fingerprint: field.fingerprint ?? null,
        sample: mode.sample ?? field.sample ?? (field.fingerprint?.textSample || null),
        threshold: draft.healing?.fuzzyThreshold ?? 0.7,
        reason: mode.reason,
        picked: null,
      };
    }
    this.current = {
      url: 'about:blank',
      draft,
      selected: null,
      proposal: null,
      levelPick: null,
      editing: null,
      pendingSelect: null,
      selectorError: null,
      urlError: null,
      varError: null,
      pathChecks: {},
      descriptionError: null,
      openedUrl: '',
      repick: repickContext ? repickContext.index : null,
      repickStep: null,
      pickTrigger: null,
      panelMode: 'owner',
      popup: false,
      repickContext,
      guardContext: null,
      notice: null,
      otherLists: [],
      frame: null,
      test: null,
      saved: null,
      busy: null,
      error: null,
      panel: { collapsed: { recipe: false, flows: false, sequence: true } },
    };
    this.closedPromise = new Promise((resolve) => (this.closedResolve = resolve));
    this.repickPromise = new Promise((resolve) => (this.repickResolve = resolve));
  }

  /** Resolves when a focused re-pick is confirmed, skipped, or aborted; closing the browser aborts. */
  awaitRepick(): Promise<RepickOutcome> {
    return this.repickPromise;
  }

  get state(): RecorderState {
    return this.current;
  }

  get draft(): Draft {
    return this.current.draft;
  }

  /** The active table: it receives picks, item inference, and field edits. */
  private table(): DraftTable {
    return currentTable(this.current.draft);
  }

  /** Resolves when the user closes the browser or ends the session from the panel. */
  closed(): Promise<'closed' | 'ended'> {
    return this.closedPromise;
  }

  /** The frame-scoped session; see `view`. */
  private get session(): InteractiveSession {
    return this.view;
  }

  /** The owner window's session itself, for work that finds frames on its own: test runs, step replays, navigation. */
  private get raw(): InteractiveSession {
    return this.windows.get(this.owner)?.session ?? this.opts.session;
  }

  /** Whether the panel's owner is a popup, where recorded steps act and fields cannot be added. */
  private ownerIsPopup(): boolean {
    return this.owner !== MAIN_WINDOW;
  }

  /** Make a window the owner: it gets the full panel, the others the rail or the strip. */
  private async setOwner(id: string): Promise<void> {
    if (id === this.owner || !this.windows.has(id)) return;
    this.owner = id;
    // Paths of a selection or a list setup belong to the previous window's document.
    if (this.current.selected || this.current.proposal || this.current.editing) this.clearSelection();
    const url = await this.raw.url().catch(() => this.current.url);
    this.current = { ...this.current, url, panelMode: 'owner', popup: this.ownerIsPopup(), levelPick: null };
    this.emitter.emit('recorder.owner', { window: id });
    await this.broadcast();
  }

  /** Tell every window how to show the panel: the owner gets the state, the others their mode. */
  private async broadcast(): Promise<void> {
    for (const [id, win] of this.windows) {
      if (id === this.owner) continue;
      try {
        await win.session.dispatch(this.modeMessage(id));
      } catch {
        // The window is navigating or closing; it asks again once ready.
      }
    }
    await this.push();
  }

  private modeMessage(id: string): HostMessage {
    return { kind: 'panel.mode', mode: id === MAIN_WINDOW ? 'rail' : 'strip', popup: id !== MAIN_WINDOW };
  }

  /** A popup of the session: it takes the panel when it opens and hands it back to its opener when it closes. */
  private addWindow(win: RecorderWindow): void {
    this.windows.set(win.id, { session: win.session, opener: win.opener });
    // A popup starts on about:blank, whose window Chromium keeps for the first page it loads, so the
    // context's script may never boot there: load the bundle now and once the first page commits.
    const bundle = this.opts.bundle;
    void win.session.inject(bundle).catch(() => {});
    const offFirst = win.session.onNavigated(() => {
      offFirst();
      void win.session.inject(bundle).catch(() => {});
    });
    this.unsubscribe.push(
      offFirst,
      win.session.onNavigated((url) => {
        if (this.owner !== win.id) return;
        this.current = { ...this.current, url };
        this.emitter.emit('recorder.navigated', { url });
      }),
      win.session.onClosed(() => {
        const entry = this.windows.get(win.id);
        this.windows.delete(win.id);
        if (this.owner !== win.id) return;
        const opener = entry && this.windows.has(entry.opener) ? entry.opener : MAIN_WINDOW;
        void this.handleInternal(async () => {
          // The closed window is gone: hand the panel back without asking it.
          this.owner = '';
          await this.setOwner(opener);
        });
      }),
    );
    void this.handleInternal(() => this.setOwner(win.id));
  }

  /** The frame host lookups run in: the override, else the selection's (null in the top document), else the active table's. */
  private scopeFrame(): FrameTarget | null {
    if (this.frameOverride) return this.frameOverride.frame;
    const selected = this.current.selected;
    if (selected) return selected.selection.frame;
    return this.table().frame ?? null;
  }

  /** The current frame's document root: undefined for the top document, null when the frame is missing or does not load. */
  private frameBase(): Promise<ElementRef | null> | undefined {
    const frame = this.scopeFrame();
    if (!frame) return undefined;
    const key = frame.selectors.map((c) => `${c.strategy}=${c.value}`).join('|');
    if (this.frameMemo?.key !== key) {
      const raw = this.raw;
      const timeoutMs = this.opts.timeoutMs ?? 30_000;
      this.frameMemo = {
        key,
        root: (async () => {
          const found = await resolveFirst(raw, frame.selectors.map(bare));
          return found ? raw.frameRoot(found.refs[0]!, { timeoutMs }) : null;
        })(),
      };
    }
    return this.frameMemo.root;
  }

  /** Run lookups in one frame (null: the top document), whatever the selection or the active table. */
  private async inFrame<T>(frame: FrameTarget | null, work: () => Promise<T>): Promise<T> {
    const before = this.frameOverride;
    this.frameOverride = { frame };
    try {
      return await work();
    } finally {
      this.frameOverride = before;
    }
  }

  /** Put the current frame in the state, for the page to read paths in the right document. */
  private syncFrame(): void {
    const frame = this.scopeFrame();
    const path = this.current.selected?.selection.framePath ?? null;
    const view = frame ? { path, selectors: frame.selectors } : null;
    if (JSON.stringify(view) !== JSON.stringify(this.current.frame)) this.current = { ...this.current, frame: view };
  }

  /** The frame candidates counted in the top document; those that match nothing are dropped, unique ones first. */
  private async verifyFrame(frame: FrameTarget): Promise<FrameTarget> {
    const counted: ProtocolCandidate[] = [];
    for (const c of frame.selectors) {
      let count = 0;
      try {
        count = (await this.raw.resolve(bare(c))).length;
      } catch {
        // An invalid selector matches nothing.
      }
      counted.push({ ...c, count });
    }
    const found = counted.filter((c) => (c.count ?? 0) > 0);
    const selectors = [...found.filter((c) => c.count === 1), ...found.filter((c) => c.count !== 1)];
    return { ...frame, selectors: selectors.length > 0 ? selectors : counted };
  }

  /** Why a pick in `frame` cannot go into a table: the table already reads from another frame, or from the top document. */
  private frameRefusal(table: number | null, frame: FrameTarget | null): string | null {
    const t = table === null ? null : this.draft.tables[table];
    if (!t || (t.fields.length === 0 && !t.item)) return null;
    if (sameFrame(t.frame ?? null, frame)) return null;
    return t.frame ? `the ${t.name} table reads from ${frameLabel(t.frame)}` : `the ${t.name} table reads from the page, not from an iframe`;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** The URL the draft's template and variable values produce. */
  targetUrl(): string {
    const values = Object.fromEntries(this.draft.vars.map((v) => [v.name, v.value]));
    return fillTemplate(this.draft.url, [], values);
  }

  /** Expose the bridge, inject the bundle, and open the target URL. */
  async start(): Promise<PageInfo> {
    await this.attach();
    const target = this.targetUrl();
    this.current = { ...this.current, openedUrl: target };
    const info = await this.session.goto(target, { timeoutMs: this.opts.timeoutMs ?? 30_000 });
    this.current = { ...this.current, url: info.url };
    return info;
  }

  /**
   * Expose the bridge and inject the bundle into the page already open, without
   * navigating. The page announces itself with `session.ready` and gets the state.
   */
  async attach(): Promise<void> {
    const main = this.opts.session;
    await main.expose(HOST_BINDING, (msg, windowId) => this.handle(msg, windowId));
    await main.inject(this.opts.bundle);
    this.unsubscribe.push(
      main.onWindow((win) => this.addWindow(win)),
      main.onNavigated((url) => {
        if (this.owner !== MAIN_WINDOW) return;
        this.current = { ...this.current, url };
        this.emitter.emit('recorder.navigated', { url });
      }),
      main.onClosed(() => {
        this.repickResolve({ kind: 'abort' });
        if (this.current.guardContext && this.opts.abortOnClose !== false) this.fireGuard('abort');
        this.closedResolve('closed');
      }),
    );
  }

  /** Remove the recorder from the page (panel, overlay, page margin, listeners) and stop listening. The session stays open. */
  async detach(): Promise<void> {
    await this.idle();
    try {
      await this.session.dispatch({ kind: 'session.detach' } satisfies HostMessage);
    } catch {
      // The page is gone or navigating; nothing is left to remove.
    }
    this.detached = true;
    this.dispose();
  }

  /** Show the guard banner and return hooks for its buttons. */
  async showGuard(ctx: GuardContextView): Promise<GuardHooks> {
    this.current = { ...this.current, guardContext: ctx };
    this.guardListeners.continue.clear();
    this.guardListeners.abort.clear();
    await this.push();
    return {
      onContinue: (cb) => void this.guardListeners.continue.add(cb),
      onAbort: (cb) => void this.guardListeners.abort.add(cb),
    };
  }

  /** Remove the guard banner; the buttons stop firing. */
  async hideGuard(): Promise<void> {
    this.current = { ...this.current, guardContext: null };
    this.guardListeners.continue.clear();
    this.guardListeners.abort.clear();
    await this.push();
  }

  private fireGuard(which: 'continue' | 'abort'): void {
    for (const cb of this.guardListeners[which]) cb();
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** Entry point for the page binding, with the window that called. Messages are handled one at a time, in order. */
  handle(raw: unknown, windowId: string = MAIN_WINDOW): Promise<HostMessage> {
    const run = this.queue.then(() => this.process(raw, windowId));
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * A message from a window that does not own the panel: a real pointer or key
   * press makes it the owner; anything else is answered with its panel mode.
   */
  private async fromOther(msg: ParsedPageMessage, windowId: string): Promise<HostMessage> {
    if (this.detached) return { kind: 'session.detach' };
    if (msg.kind === 'window.activity' && this.windows.has(windowId)) {
      await this.setOwner(windowId);
      return this.stateMessage();
    }
    return this.modeMessage(windowId);
  }

  private async process(raw: unknown, windowId: string = MAIN_WINDOW): Promise<HostMessage> {
    // Frame documents may have been replaced since the last message.
    this.frameMemo = null;
    try {
      const msg = parsePageMessage(raw);
      if (windowId !== this.owner) return await this.fromOther(msg, windowId);
      const reply = await this.route(msg);
      if (this.current.error) this.current = { ...this.current, error: null };
      this.syncFrame();
      return reply && 'state' in reply ? { ...reply, state: this.outgoing() } : (reply ?? this.stateMessage());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.current = { ...this.current, error: message, busy: null };
      this.emitter.emit('recorder.error', { message });
      return this.stateMessage();
    }
  }

  private stateMessage(): HostMessage {
    this.syncFrame();
    return { kind: 'draft.state', state: this.outgoing() };
  }

  /** The state as the page gets it: secret values stay on the host, the panel only learns that one is set. */
  private outgoing(): RecorderState {
    const draft = this.current.draft;
    if (!draft.vars.some((v) => v.secret)) return this.current;
    const vars = draft.vars.map((v) => (v.secret ? { ...v, value: '', ...(v.value !== '' ? { set: true as const } : {}) } : v));
    return { ...this.current, draft: { ...draft, vars } };
  }

  /** Check on the host that each path of a path variable names an existing file. */
  private async checkPath(name: string): Promise<void> {
    const variable = this.draft.vars.find((v) => v.name === name);
    if (!variable || variable.type !== 'path') {
      const { [name]: _, ...rest } = this.current.pathChecks;
      this.current = { ...this.current, pathChecks: rest };
      return;
    }
    const files = this.opts.files;
    const paths = await Promise.all(
      splitPaths(variable.value).map(async (path) => ({ path, exists: files ? await files.readable(files.resolve(path)) : false })),
    );
    this.current = { ...this.current, pathChecks: { ...this.current.pathChecks, [name]: { value: variable.value, paths } } };
  }

  /** Send the current state to the owner window without waiting for a page request. */
  async push(): Promise<void> {
    try {
      await this.raw.dispatch(this.stateMessage());
    } catch {
      // The page is navigating; it asks for the state again once it is ready.
    }
  }

  private apply(action: DraftAction): void {
    this.current = { ...this.current, draft: reduceDraft(this.current.draft, action) };
  }

  /** Apply an accepted template or variable edit; it clears both inline errors. */
  private applyVar(action: DraftAction): void {
    this.apply(action);
    this.current = { ...this.current, urlError: null, varError: null };
  }

  /** Commit a URL template, or refuse it into `urlError` and keep the previous one. */
  private setUrl(url: string): void {
    const problem = templateProblem(url);
    if (problem) this.current = { ...this.current, urlError: problem };
    else this.applyVar({ type: 'setUrl', url });
  }

  private async route(msg: ParsedPageMessage): Promise<HostMessage | void> {
    switch (msg.kind) {
      case 'session.ready':
        // A page loaded after the host detached still runs the injected bundle; tell it to go away.
        if (this.detached) return { kind: 'session.detach' };
        // Attached to a page the session did not open: that page is the last opened URL.
        this.current = { ...this.current, url: msg.url, openedUrl: this.current.openedUrl || msg.url };
        this.emitter.emit('recorder.ready', { url: msg.url });
        // Counts refresh after the reply, so the panel renders at once.
        void this.handleInternal(async () => {
          await this.recount();
          await this.push();
        });
        return;
      case 'session.end':
        this.repickResolve({ kind: 'abort' });
        this.closedResolve('ended');
        return;
      case 'picker.hover':
        return;
      case 'picker.cancel':
        if (this.current.levelPick) this.current = { ...this.current, levelPick: null };
        return;
      case 'picker.select':
        this.current = { ...this.current, url: msg.url };
        return void (await this.select(msg.selection, msg.snapshot as AnnotatedNode));
      case 'selection.clear':
        this.clearSelection();
        return;
      case 'selection.setSelector':
        return void (await this.setSelector(msg.selector, msg.scope, msg.snapshot));
      case 'selection.retarget':
        return void (await this.retarget(msg.table));
      case 'inspect.count': {
        const containers = msg.scope === 'item' ? await this.targetContainers() : [];
        const count = msg.scope === 'item' ? (await this.countIn(msg.candidate, containers)).count : await this.countPage(msg.candidate);
        return { kind: 'inspect.countResult', count };
      }
      case 'inspect.primary': {
        const selected = this.current.selected;
        const editing = this.current.editing;
        if (!selected && editing && msg.index < editing.candidates.length) {
          this.current = { ...this.current, editing: { ...editing, primary: msg.index } };
          return;
        }
        if (!selected || msg.index >= selected.selection.candidates.length) throw new Error('no candidate at that index');
        this.current = { ...this.current, selected: { ...selected, primary: msg.index } };
        return;
      }
      case 'draft.confirmItems':
        return void (await this.confirmItems());
      case 'draft.cancelItems':
        // Cancelling an edit of the confirmed item returns to the empty state; the item stays.
        // Otherwise the selection comes back with its suggestion.
        if (this.current.proposal?.origin === 'edit') this.clearSelection();
        else this.dropProposal();
        return;
      case 'list.open':
        return void (await this.openList(msg.from));
      case 'list.dismiss': {
        const selected = this.current.selected;
        if (!selected) throw new Error('select an element first');
        this.current = { ...this.current, selected: { ...selected, suggestion: null } };
        return;
      }
      case 'list.ladder': {
        if (!this.proposal || !this.current.proposal) throw new Error('no list setup is open');
        const rows = msg.which === 'item' ? { itemLadder: await this.itemLadder() } : { parentLadder: await this.parentLadder() };
        this.current = { ...this.current, proposal: { ...this.current.proposal, ...rows } };
        return;
      }
      case 'draft.editItem':
        return void (await this.editItem(msg.snapshot));
      case 'draft.setLevel':
        return void (await this.setLevel(msg.level, msg.by, msg));
      case 'draft.pickLevel':
        this.current = { ...this.current, levelPick: this.levelPickFor(msg.level) };
        return;
      case 'draft.toggleIncludeAll':
        if (!this.proposal || !this.current.proposal) throw new Error('no item proposal to change');
        this.edits = { ...this.edits, includeAll: !this.edits.includeAll };
        return void (await this.showProposal());
      case 'draft.setPrimary':
        return void (await this.setPrimary(msg.level, msg.index));
      case 'draft.clearItem':
        this.notEditingItem();
        if (this.table().fields.length > 0) throw new Error('the list is locked by its fields: use Clear table to start over');
        this.apply({ type: 'setItem', item: null });
        await this.recount();
        return;
      case 'draft.clearTable':
        this.notEditing();
        this.notEditingItem();
        this.clearSelection();
        this.apply({ type: 'clearTable' });
        await this.refreshOtherLists();
        return;
      case 'draft.moveFieldToPage': {
        this.notEditing();
        this.notEditingItem();
        const field = this.table().fields[msg.index];
        if (!field) throw new Error(`no field at index ${msg.index}`);
        this.apply({ type: 'moveFieldToPage', index: msg.index });
        await this.recount();
        return;
      }
      case 'draft.addExclusion':
        return void (await this.addExclusion(msg.selector));
      case 'draft.removeExclusion':
        return void (await this.removeExclusion(msg.index));
      case 'draft.addField':
        this.notEditing();
        return void (await this.addField(msg.patch ?? {}));
      case 'draft.editField':
        this.notEditingItem();
        if (msg.table !== undefined && msg.table !== this.draft.activeTable) this.activate(msg.table);
        return void (await this.editField(msg.index, msg.snapshot));
      case 'draft.updateEditedField':
        return void (await this.updateEditedField(msg.patch));
      case 'draft.cancelEdit':
        if (!this.current.editing) throw new Error('no field is being edited');
        this.clearSelection();
        return;
      case 'draft.updateField': {
        const before = this.table().fields[msg.index];
        if (!before) throw new Error(`no field at index ${msg.index}`);
        this.apply({ type: 'updateField', index: msg.index, patch: msg.patch });
        if (msg.patch.type !== undefined || msg.patch.attr !== undefined || msg.patch.scope !== undefined) await this.recount();
        return;
      }
      case 'draft.removeField': {
        const field = this.table().fields[msg.index];
        if (!field) throw new Error(`no field at index ${msg.index}`);
        // Indexes shift: an open edit ends without changes.
        if (this.current.editing) this.clearSelection();
        this.apply({ type: 'removeField', index: msg.index });
        this.emitter.emit('recorder.fieldRemoved', { name: field.name });
        return;
      }
      case 'draft.moveField':
        if (this.current.editing) this.clearSelection();
        this.apply({ type: 'moveField', from: msg.from, to: msg.to });
        return;
      case 'draft.repickTarget':
        if (msg.target === 'field') this.current = { ...this.current, repick: msg.index, repickStep: null };
        else this.current = { ...this.current, repickStep: msg.index === null ? null : { flow: this.flowIndex(msg.flow), index: msg.index }, repick: null };
        return;
      case 'draft.addStep':
        if (msg.selection === undefined) this.notEditing();
        return void (await this.addStep(msg.step, msg.selection, msg.flow));
      case 'draft.updateStep': {
        const flow = this.flowIndex(msg.flow);
        this.stepOf(flow, msg.index);
        this.apply({ type: 'updateStep', flow, index: msg.index, patch: msg.patch });
        return;
      }
      case 'draft.removeStep': {
        const flow = this.flowIndex(msg.flow);
        this.stepOf(flow, msg.index);
        this.apply({ type: 'removeStep', flow, index: msg.index });
        return;
      }
      case 'draft.moveStep':
        this.apply({ type: 'moveStep', flow: this.flowIndex(msg.flow), from: msg.from, to: msg.to });
        return;
      case 'draft.replayStep':
        return this.replay(this.flowIndex(msg.flow), msg.index);
      case 'draft.addFlow': {
        const typed = msg.name?.trim();
        const name = typed || defaultFlowName(this.draft);
        const error = flowNameError(this.draft, name);
        if (error) throw new Error(error);
        this.apply({ type: 'addFlow', name });
        return;
      }
      case 'draft.updateFlow': {
        const flow = this.draft.flows[msg.index];
        if (!flow) throw new Error(`no flow at index ${msg.index}`);
        if (msg.patch.name !== undefined) {
          const error = flowNameError(this.draft, msg.patch.name.trim(), msg.index);
          if (error) throw new Error(error);
        }
        this.apply({ type: 'updateFlow', index: msg.index, patch: { ...msg.patch, ...(msg.patch.name !== undefined ? { name: msg.patch.name.trim() } : {}) } });
        return;
      }
      case 'draft.removeFlow':
        if (!this.draft.flows[msg.index]) throw new Error(`no flow at index ${msg.index}`);
        this.apply({ type: 'removeFlow', index: msg.index });
        return;
      case 'draft.duplicateFlow':
        if (!this.draft.flows[msg.index]) throw new Error(`no flow at index ${msg.index}`);
        this.apply({ type: 'duplicateFlow', index: msg.index });
        return;
      case 'draft.selectFlow':
        if (!this.draft.flows[msg.index]) throw new Error(`no flow at index ${msg.index}`);
        this.apply({ type: 'selectFlow', index: msg.index });
        return;
      case 'draft.replayFlow':
        return this.replay(msg.index, null);
      case 'draft.replayFlowsBefore':
        return this.replayFlowsBefore(msg.table);
      case 'draft.pickTrigger':
        if (msg.index !== null && !this.draft.flows[msg.index]) throw new Error(`no flow at index ${msg.index}`);
        this.current = { ...this.current, pickTrigger: msg.index };
        return;
      case 'draft.setTrigger':
        return void (await this.setTrigger(msg.index, msg.selection));
      case 'draft.markPagination':
        this.notEditing();
        await this.markPagination();
        // The collapsed Sequence section opens on the paginate block just set.
        if (this.draft.pagination) this.current = { ...this.current, panel: { collapsed: { ...this.current.panel.collapsed, sequence: false } } };
        return;
      case 'paginate.update':
        if (!this.draft.pagination) throw new Error('mark a pagination target first');
        this.apply({ type: 'updatePagination', patch: msg.patch });
        this.emitter.emit('recorder.paginationSet', { kind: this.draft.pagination!.kind });
        return;
      case 'draft.clearPagination':
        this.apply({ type: 'setPagination', pagination: null });
        return;
      case 'sequence.move':
        this.apply({ type: 'moveBlock', from: msg.from, to: msg.to });
        return;
      case 'sequence.customize':
        this.apply({ type: 'customizeSequence' });
        return;
      case 'sequence.reset':
        this.apply({ type: 'resetSequence' });
        return;
      case 'window.activity':
        return;
      case 'draft.addTable': {
        this.notEditingItem();
        const typed = msg.name?.trim();
        const name = typed || defaultTableName(this.draft);
        const error = tableNameError(this.draft, name);
        if (error) throw new Error(error);
        // A selection is kept and computed for the new table; anything else belongs to the previous one.
        const keep = this.current.selected !== null && !this.current.editing;
        if (!keep) this.clearSelection();
        this.apply({ type: 'addTable', name, defaultName: !typed });
        if (keep) await this.retarget(this.draft.activeTable);
        await this.refreshOtherLists();
        return;
      }
      case 'draft.renameTable': {
        const name = msg.name.trim();
        const error = tableNameError(this.draft, name, this.draft.activeTable);
        if (error) throw new Error(error);
        this.apply({ type: 'renameTable', name });
        return;
      }
      case 'draft.removeTable':
        if (this.draft.tables.length < 2) throw new Error('a recipe needs at least one table');
        this.notEditingItem();
        this.clearSelection();
        this.apply({ type: 'removeTable' });
        await this.refreshOtherLists();
        return;
      case 'draft.selectTable':
        this.notEditingItem();
        if (this.current.selected && !this.current.editing && this.draft.tables[msg.index]) {
          // The selection follows the active tab: computed again for the table.
          this.current = { ...this.current, repick: null, repickStep: null };
          this.apply({ type: 'selectTable', index: msg.index });
          await this.retarget(msg.index);
        } else this.activate(msg.index);
        await this.refreshOtherLists();
        return;
      case 'draft.moveTable': {
        this.notEditingItem();
        const { from, to } = msg;
        if (!this.draft.tables[from] || !this.draft.tables[to]) throw new Error(`no table at index ${this.draft.tables[from] ? to : from}`);
        const order = this.draft.tables.map((_, i) => i);
        order.splice(to, 0, order.splice(from, 1)[0]!);
        this.apply({ type: 'moveTable', from, to });
        const selected = this.current.selected;
        if (selected && selected.table !== null) {
          const at = (i: number | null | undefined) => (i === null || i === undefined ? null : order.indexOf(i));
          this.current = {
            ...this.current,
            selected: {
              ...selected,
              table: order.indexOf(selected.table),
              defaults: { ...selected.defaults, table: order.indexOf(selected.defaults.table) },
              outside: selected.outside ? { ...selected.outside, table: at(selected.outside.table)!, pageTable: at(selected.outside.pageTable) } : null,
              belongs: selected.belongs ? { ...selected.belongs, table: at(selected.belongs.table)! } : null,
            },
          };
        }
        await this.refreshOtherLists();
        return;
      }
      case 'frame.edit':
        return void (await this.editFrame(msg.key, msg.by, msg.index, msg.selector));
      case 'panel.setCollapsed':
        this.current = { ...this.current, panel: { collapsed: { ...this.current.panel.collapsed, [msg.section]: msg.collapsed } } };
        return;
      case 'draft.setName':
        this.apply({ type: 'setName', name: msg.name });
        return;
      case 'draft.setDescription': {
        const key = descriptionKey(msg.target);
        if (msg.text.trim().length > DESCRIPTION_MAX) {
          this.current = { ...this.current, descriptionError: { key, message: `a description is at most ${DESCRIPTION_MAX} characters` } };
          return;
        }
        this.apply({ type: 'setDescription', target: msg.target, text: msg.text });
        if (this.current.descriptionError?.key === key) this.current = { ...this.current, descriptionError: null };
        return;
      }
      case 'draft.setHumanize':
        this.apply({ type: 'setHumanize', on: msg.on });
        return;
      case 'draft.setVar':
        this.applyVar({ type: 'setVar', name: msg.name, value: msg.value });
        if (this.draft.vars.some((v) => v.name === msg.name && v.type === 'path')) await this.checkPath(msg.name);
        return;
      case 'draft.setVarKind':
        this.applyVar({ type: 'setVarKind', name: msg.name, ...(msg.secret !== undefined ? { secret: msg.secret } : {}), ...(msg.type !== undefined ? { varType: msg.type } : {}) });
        await this.checkPath(msg.name);
        return;
      case 'vars.checkPath':
        return void (await this.checkPath(msg.name));
      case 'draft.reopen': {
        const target = this.targetUrl();
        this.current = { ...this.current, openedUrl: target };
        // Navigating tears down the page that sent this message; do not wait for it.
        void this.handleInternal(() => this.session.goto(target, { timeoutMs: this.opts.timeoutMs ?? 30_000 }));
        return;
      }
      case 'draft.setUrl':
        this.setUrl(msg.url);
        return;
      case 'draft.useCurrentUrl':
        this.setUrl(retemplateUrl(this.current.url, this.draft.vars));
        return;
      case 'draft.addVar': {
        const error = varNameError(this.draft, msg.name);
        if (error) this.current = { ...this.current, varError: { name: msg.name, message: error } };
        else this.applyVar({ type: 'addVar', name: msg.name });
        return;
      }
      case 'draft.renameVar': {
        const error = msg.from === msg.to ? null : varNameError(this.draft, msg.to);
        if (error) this.current = { ...this.current, varError: { name: msg.from, message: error } };
        else this.applyVar({ type: 'renameVar', from: msg.from, to: msg.to });
        return;
      }
      case 'draft.removeVar':
        this.applyVar({ type: 'removeVar', name: msg.name });
        return;
      case 'test.run': {
        const results = await this.testRun();
        return { kind: 'test.results', results, state: this.current };
      }
      case 'test.clear':
        this.current = { ...this.current, test: null };
        return;
      case 'save.request':
        return this.save();
      case 'repick.confirm':
        return this.confirmRepick();
      case 'repick.skip':
        if (!this.current.repickContext) throw new Error('no re-pick is in progress');
        this.repickResolve({ kind: 'skip' });
        return;
      case 'repick.abort':
        if (!this.current.repickContext) throw new Error('no re-pick is in progress');
        this.repickResolve({ kind: 'abort' });
        return;
      case 'guard.continue':
      case 'guard.abort':
        if (!this.current.guardContext) throw new Error('the run is not waiting on a guard');
        this.fireGuard(msg.kind === 'guard.continue' ? 'continue' : 'abort');
        return;
    }
  }

  /** Accept the picked element for the re-picked field; from the command line this also saves the recipe. */
  private async confirmRepick(): Promise<HostMessage | void> {
    const ctx = this.current.repickContext;
    if (!ctx) throw new Error('no re-pick is in progress');
    if (!ctx.picked) throw new Error(`pick the new location of ${ctx.field} first`);
    const field = this.table().fields[ctx.index]!;
    let reply: HostMessage | undefined;
    if (ctx.reason === 'cli') {
      reply = await this.save();
      if (reply.kind === 'save.result' && !reply.ok) return reply;
    }
    this.repickResolve({
      kind: 'picked',
      selectors: field.selectors.map(bare),
      ...(field.fingerprint ? { fingerprint: field.fingerprint } : {}),
    });
    return reply;
  }

  /** Run work on the message queue, reporting errors to the page. */
  private handleInternal(work: () => Promise<unknown>): Promise<void> {
    const run = this.queue.then(() => {
      this.frameMemo = null;
      return work();
    }).then(
      () => {},
      async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.current = { ...this.current, error: message };
        this.emitter.emit('recorder.error', { message });
        await this.push();
      },
    );
    this.queue = run;
    return run;
  }

  /** Wait for queued work, for tests and shutdown. */
  async idle(): Promise<void> {
    for (let previous: Promise<unknown> | null = null; previous !== this.queue; ) {
      previous = this.queue;
      await previous;
    }
  }

  // Counting ----------------------------------------------------------------

  /** Item containers of the active table. */
  private containers(): Promise<ElementRef[]> {
    return this.containersOf(this.table().item);
  }

  private async containersOf(item: DraftItem | null): Promise<ElementRef[]> {
    if (!item) return [];
    // A list in another document than the one lookups run in has no containers here.
    const owner = this.draft.tables.find((t) => t.item === item);
    if (owner && !sameFrame(owner.frame ?? null, this.scopeFrame())) return [];
    const parent = await listParent(this.session, item.within?.map(bare));
    if (parent === null) return [];
    return containersFor(this.session, item.selectors.map(bare), item.exclude.map(bare), parent);
  }

  /** Item containers of the table the selection targets, else of the active table. */
  private targetContainers(): Promise<ElementRef[]> {
    const target = this.current.selected?.table;
    if (target === null) return Promise.resolve([]);
    return this.containersOf(this.draft.tables[target ?? this.draft.activeTable]?.item ?? null);
  }

  private async countPage(candidate: ProtocolCandidate): Promise<number> {
    try {
      return (await this.session.resolve(bare(candidate))).length;
    } catch {
      return 0;
    }
  }

  /** Matches inside the containers, and how many containers hold at least one; zero for an invalid selector. */
  private async countIn(candidate: ProtocolCandidate, containers: readonly ElementRef[]): Promise<{ count: number; items: number }> {
    let count = 0;
    let items = 0;
    for (const container of containers) {
      try {
        const found = (await this.session.resolve(bare(candidate), container)).length;
        count += found;
        if (found > 0) items++;
      } catch {
        return { count: 0, items: 0 };
      }
    }
    return { count, items };
  }

  /** Item containers of the active table in which the primary matches, out of their count; null for a page field or without an item block. */
  private async coverageOf(scope: FieldScope, primary: ProtocolCandidate, containers: readonly ElementRef[]): Promise<{ matched: number; total: number } | null> {
    if (scope !== 'item' || !this.table().item) return null;
    return { matched: (await this.countIn(primary, containers)).items, total: containers.length };
  }

  /** Candidates with host counts; `coverage` adds the item coverage to item scoped ones. */
  private async withCounts<T extends Candidate>(
    candidates: readonly T[],
    scope: FieldScope,
    containers: readonly ElementRef[],
    coverage = false,
  ): Promise<T[]> {
    const out: T[] = [];
    for (const c of candidates) {
      if (scope === 'item') {
        const { count, items } = await this.countIn(c, containers);
        out.push(coverage ? { ...c, count, items } : { ...c, count });
      } else out.push({ ...c, count: await this.countPage(c) });
    }
    return out;
  }

  /** Converted value of the primary selector's first match, as the run would read it. */
  private async sample(
    field: { selectors: ProtocolCandidate[]; type: FieldType; attr?: string; scope: FieldScope },
    containers: readonly ElementRef[],
  ): Promise<string | null> {
    const primary = field.selectors[0];
    if (!primary) return null;
    try {
      const within = field.scope === 'item' ? containers[0] : undefined;
      if (field.scope === 'item' && !within) return null;
      const [ref] = await this.session.resolve(bare(primary), within);
      if (!ref) return null;
      const attr = field.attr ?? defaultAttr(field.type);
      const raw = await this.session.read(ref, { ...(attr ? { attr } : {}), mode: field.type === 'html' ? 'html' : 'text' });
      const value = convertValue(field.type, raw, this.current.url);
      return value === null ? null : String(value).slice(0, 120);
    } catch {
      return null;
    }
  }

  /** Refresh every table's item and field counts, and the step counts, on the current page. */
  async recount(): Promise<void> {
    for (let t = 0; t < this.draft.tables.length; t++) await this.inFrame(this.draft.tables[t]!.frame ?? null, () => this.recountTable(t));
    const stepCounts: (number | null)[][] = [];
    for (const flow of this.draft.flows) {
      const counts: (number | null)[] = [];
      for (const step of flow.steps) {
        const target = step.target;
        counts.push(target ? await this.inFrame(target.frame ?? null, () => this.countPage(target.selectors[0]!)) : null);
      }
      stepCounts.push(counts);
    }
    this.apply({ type: 'setStepCounts', counts: stepCounts });
    await this.refreshOtherLists();
  }

  /** A flow index from a message: the given one, else the active flow; throws when there is none. */
  private flowIndex(index: number | undefined): number {
    const flow = index ?? this.draft.activeFlow;
    if (flow === null || !this.draft.flows[flow]) throw new Error(index === undefined ? 'no flow is active' : `no flow at index ${index}`);
    return flow;
  }

  private stepOf(flow: number, index: number) {
    const step = this.draft.flows[flow]?.steps[index];
    if (!step) throw new Error(`no step at index ${index} of flow ${this.draft.flows[flow]?.name ?? flow}`);
    return step;
  }

  /** While the active table is a list, the paths of every other list table's containers, for muted outlines on the page. */
  private async refreshOtherLists(): Promise<void> {
    const active = this.draft.activeTable;
    const lists = this.draft.tables.flatMap((t, i) => (i !== active && t.item ? [{ item: t.item, table: i }] : []));
    if (!this.table().item || lists.length === 0) {
      if (this.current.otherLists.length > 0) this.current = { ...this.current, otherLists: [] };
      return;
    }
    let root: AnnotatedNode;
    try {
      root = annotate((await this.session.snapshot()) as SerializedElement);
    } catch {
      return;
    }
    const otherLists: RecorderState['otherLists'] = [];
    for (const { item, table } of lists) {
      const nodes = await this.nodesFor(await this.containersOf(item), root);
      otherLists.push({ table, paths: nodes.map(pathOf) });
    }
    this.current = { ...this.current, otherLists };
  }

  private async recountTable(t: number): Promise<void> {
    const item = this.draft.tables[t]!.item;
    let containers: ElementRef[] = [];
    if (item) {
      const parent = await listParent(this.session, item.within?.map(bare));
      const resolved = parent === null ? null : await resolveFirst(this.session, item.selectors.map(bare), parent);
      const total = resolved?.refs.length ?? 0;
      containers = resolved ? await excludeContainers(this.session, resolved.refs, item.exclude.map(bare)) : [];
      const exclude: ProtocolCandidate[] = [];
      for (const c of item.exclude) exclude.push({ ...c, count: await this.countPage(c) });
      const tables = this.draft.tables.map((table, i) => (i === t && table.item ? { ...table, item: { ...table.item, exclude } } : table));
      this.current = { ...this.current, draft: { ...this.draft, tables } };
      const withinCount = item.within?.[0] ? await this.countPage(item.within[0]) : null;
      this.apply({ type: 'setItemCounts', count: containers.length, total, withinCount, table: t });
    }
    const counts: { count: number | null; sample: string | null; coverage: { matched: number; total: number } | null }[] = [];
    for (const field of this.draft.tables[t]!.fields) {
      const primary = field.selectors[0]!;
      let count: number;
      let coverage: { matched: number; total: number } | null = null;
      if (field.scope === 'item') {
        const found = await this.countIn(primary, containers);
        count = found.count;
        if (item) coverage = { matched: found.items, total: containers.length };
      } else count = await this.countPage(primary);
      counts.push({ count, sample: count > 0 ? await this.sample(field, containers) : null, coverage });
    }
    this.apply({ type: 'setFieldCounts', counts, table: t });
  }

  // Selection ---------------------------------------------------------------

  /** Take a pick: inside an iframe, its frame candidates are checked in the top document and lookups run in that frame. */
  private async select(selection: ParsedSelection, snapshot: AnnotatedNode): Promise<void> {
    const frame = selection.frame ? await this.verifyFrame(selection.frame) : null;
    await this.inFrame(frame, () => this.selectIn({ ...selection, frame }, snapshot));
  }

  private async selectIn(selection: ParsedSelection, snapshot: AnnotatedNode): Promise<void> {
    const root = annotate(snapshot);
    const node = nodeAt(root, selection.path);
    if (!node) throw new Error('the selected element is not in the page snapshot');
    this.node = node;
    this.root = root;
    // A typed selector or an opened edit applies to the element the host asked the page to select.
    const pending = this.current.pendingSelect;
    const asked = pending !== null && samePath(pending.path, selection.path);
    const typed = asked ? this.typed : null;
    const seed = asked ? this.editSeed : null;
    this.typed = null;
    this.editSeed = null;
    const editing = this.current.editing;

    // Only an element chosen by hand (a pick or a crumb click) is verified.
    this.handPicked = !typed && !seed;

    const base = dedupe(selection.candidates.length > 0 ? selection.candidates : generate(node));
    const containerNode = this.table().item && selection.containerPath ? nodeAt(root, selection.containerPath) : null;
    let scope: FieldScope = 'page';
    let candidates: ProtocolCandidate[];
    if (containerNode) {
      scope = 'item';
      const containers = await this.containers();
      const relative = this.relativeTo(node, containerNode, base);
      candidates = await this.withCounts(relative, 'item', containers, true);
      if (candidates.length > 0) {
        if (this.handPicked) candidates = await this.verified(candidates, 'item', node, containerNode, containers);
        candidates = rank(candidates, { itemCount: containers.length });
      } else {
        scope = 'page';
        candidates = await this.pageCandidates(base, node);
      }
    } else {
      candidates = await this.pageCandidates(base, node);
    }
    if (typed) {
      // The typed candidate comes first as primary; generated ones of another scope do not apply.
      candidates = typed.scope === scope ? [typed.candidate, ...candidates.filter((c) => !sameSelector(c, typed.candidate))] : [typed.candidate];
      scope = typed.scope;
    } else if (seed && editing) {
      // Opening an edit: the saved candidates first, the saved primary on top, then fresh ones.
      candidates = editing.options.scope === scope ? dedupe([...seed, ...candidates]) : seed;
      scope = editing.options.scope;
    }

    // The pick stays with the active table; a pick outside its list is flagged, never moved.
    const table = this.draft.activeTable;
    const taken = this.draft.tables[table]!.fields.map((f) => f.name);
    const defaults = fieldDefaults(
      { tag: node.tag, attrs: node.attrs, text: selection.text, ...(selection.role ? { role: selection.role } : {}), ...(selection.name ? { name: selection.name } : {}) },
      taken,
    );
    this.current = {
      ...this.current,
      selected: {
        selection: { ...selection, candidates },
        scope,
        defaults: { ...defaults, table },
        primary: 0,
        table,
        suggestion: null,
        outside: null,
        belongs: null,
        frameRefusal: this.frameRefusal(table, selection.frame),
      },
      proposal: null,
      levelPick: null,
      pendingSelect: null,
      selectorError: null,
      notice: null,
    };
    this.dropProposal();
    this.emitter.emit('recorder.selected', { tag: node.tag, path: selection.path, scope, candidates });
    // An edited field takes the new selection when updated; no step, re-pick, or item inference.
    if (editing) return;

    const pickTrigger = this.current.pickTrigger;
    if (pickTrigger !== null && this.draft.flows[pickTrigger]) {
      await this.setTrigger(pickTrigger, selection);
      return;
    }

    const repickStep = this.current.repickStep;
    if (repickStep !== null && this.draft.flows[repickStep.flow]?.steps[repickStep.index]) {
      const selectors = orderForSave(rank(await this.withCounts(generate(node), 'page', [])), 0);
      this.apply({
        type: 'replaceStepTarget',
        flow: repickStep.flow,
        index: repickStep.index,
        selectors,
        fingerprint: selection.fingerprint,
        ...(selection.frame ? { frame: selection.frame } : {}),
        count: selectors[0]?.count ?? null,
      });
      this.current = { ...this.current, repickStep: null };
      return;
    }

    const repick = this.current.repick;
    if (repick !== null && this.table().fields[repick]) {
      const field = this.table().fields[repick]!;
      const containers = scope === 'item' ? await this.containers() : [];
      const selectors = orderForSave(candidates, 0);
      const sample = await this.sample({ ...field, scope, selectors }, containers);
      const coverage = selectors[0] ? await this.coverageOf(scope, selectors[0], containers) : null;
      this.apply({ type: 'replaceSelectors', index: repick, selectors, fingerprint: selection.fingerprint, count: selectors[0]?.count ?? null, coverage, sample });
      if (field.scope !== scope) this.apply({ type: 'updateField', index: repick, patch: { scope } });
      const ctx = this.current.repickContext;
      if (ctx && ctx.index === repick) {
        // Focused mode stays on this field until the pick is confirmed.
        const score = ctx.fingerprint ? scoreFingerprint(ctx.fingerprint, node) : null;
        this.current = { ...this.current, repickContext: { ...ctx, picked: { score, sample, selector: bare(selectors[0]!) } } };
        return;
      }
      this.current = { ...this.current, repick: null };
      return;
    }

    if (!typed) await this.classify();
  }

  /**
   * Where the selection stands for the table it is computed for: in a table
   * without an item container, whether it repeats (the list suggestion); in a
   * list, whether it is outside every container, or inside a container of
   * another list table. Nothing changes tables on its own.
   */
  private async classify(): Promise<void> {
    const selected = this.current.selected;
    const node = this.node;
    const root = this.root;
    if (!selected || !node || !root) return;
    const base: SelectedView = { ...selected, suggestion: null, outside: null, belongs: null };
    const table = selected.table === null ? null : this.draft.tables[selected.table];
    if (!table?.item) {
      this.current = { ...this.current, selected: { ...base, suggestion: suggestionOf(inferItems(node)) } };
      return;
    }
    if (selected.selection.containerPath !== null) {
      this.current = { ...this.current, selected: base };
      return;
    }
    for (let t = 0; t < this.draft.tables.length; t++) {
      const other = this.draft.tables[t]!;
      if (t === selected.table || !other.item) continue;
      const containers = await this.containersOf(other.item);
      const nodes = await this.nodesFor(containers, root);
      const index = nodes.findIndex((c) => c !== node && isInside(node, c));
      if (index === -1) continue;
      const stack = { within: other.item.within?.[0] ?? null, item: other.item.selectors[0]! };
      this.current = { ...this.current, selected: { ...base, belongs: { table: t, index, of: containers.length, stack } } };
      return;
    }
    const repeats = suggestionOf(inferItems(node))?.count ?? null;
    const pageTable = this.draft.tables.findIndex((t) => t.item === null);
    this.current = {
      ...this.current,
      selected: { ...base, outside: { table: selected.table!, repeats, pageTable: pageTable === -1 ? null : pageTable } },
    };
  }

  /**
   * Open the list setup: from the pick's inferred list, empty for manual
   * input, or in a new table (created and activated) from the kept pick.
   * Only a table with no mode yet can become a list.
   */
  private async openList(from: 'suggestion' | 'manual' | 'newTable'): Promise<void> {
    this.notEditing();
    if (this.current.proposal) throw new Error('the list setup is already open');
    if (from === 'newTable') {
      if (!this.current.selected || !this.node) throw new Error('select an element first');
      this.current = { ...this.current, repick: null, repickStep: null };
      this.apply({ type: 'addTable', name: defaultTableName(this.draft), defaultName: true });
      await this.retarget(this.draft.activeTable);
      await this.refreshOtherLists();
    }
    const mode = tableMode(this.table());
    if (mode === 'page') throw new Error('a page table cannot become a list: use Clear table to start over');
    if (mode === 'list') throw new Error('the table is already a list: edit it from the Rows section');
    if (from === 'manual') {
      this.origin = 'manual';
      this.root ??= annotate((await this.session.snapshot()) as SerializedElement);
      this.proposal = { container: null, siblings: [], all: [], skipped: [], within: null };
    } else {
      if (!this.node) throw new Error('select an element first');
      const inferred = inferItems(this.node);
      if (!inferred) throw new Error('the selected element does not repeat: set up the list manually');
      this.origin = 'pick';
      this.proposal = inferred;
    }
    this.resetEdits();
    this.edits = { ...this.edits, withinInferred: this.proposal.within !== null };
    this.current = { ...this.current, proposal: null, levelPick: null, notice: null };
    await this.showProposal();
    const view = this.current.proposal!;
    this.emitter.emit('recorder.itemsProposed', {
      count: view.proposed.count,
      container: view.proposed.selectors[0]?.value ?? view.proposed.tag,
      within: view.within?.selectors[0]?.value ?? null,
      skipped: view.skipped,
    });
  }

  /** Page scoped candidates, counted, verified when picked by hand, and ranked. */
  private async pageCandidates(base: readonly Candidate[], node: AnnotatedNode): Promise<ProtocolCandidate[]> {
    const counted = await this.withCounts(base, 'page', []);
    return rank(this.handPicked ? await this.verified(counted, 'page', node, null, []) : counted);
  }

  /**
   * Verify counted candidates against the picked element. When none without
   * positional segments is a hit, the strict positional `css` candidate is
   * added (relative to the container for item scope), counted, and verified,
   * ahead of the others so it wins ties with a `:nth-child` one.
   */
  private async verified(
    candidates: readonly ProtocolCandidate[],
    scope: FieldScope,
    node: AnnotatedNode,
    containerNode: AnnotatedNode | null,
    containers: readonly ElementRef[],
  ): Promise<ProtocolCandidate[]> {
    const checked = await this.verify(candidates, scope, node, containerNode, containers);
    const known = checked.every((c) => c.hit !== undefined);
    if (!known || checked.some((c) => c.hit && !isPositional(c))) return checked;
    // With `strict`, the second `css` candidate is the strict one.
    const strict = generate(node, { strict: true }).filter((c) => c.strategy === 'css')[1];
    const relative = strict && (scope === 'item' && containerNode ? relativize(strict, containerNode) : strict);
    if (!relative || checked.some((c) => sameSelector(c, relative))) return checked;
    const counted = await this.withCounts([relative], scope, containers, scope === 'item');
    const [extra] = await this.verify(counted, scope, node, containerNode, containers);
    return extra ? [extra, ...checked] : checked;
  }

  /**
   * Mark each candidate a hit when its first match (inside the container
   * holding the picked element for item scope, else on the document) is the
   * picked element, else a miss. The picked element and its container are
   * found by their positional XPath. Every candidate stays unknown when they
   * cannot be found or the session cannot compare elements.
   */
  private async verify<T extends Candidate>(
    candidates: readonly T[],
    scope: FieldScope,
    pickedNode: AnnotatedNode,
    containerNode: AnnotatedNode | null,
    containers: readonly ElementRef[],
  ): Promise<T[]> {
    const unknown = () => candidates.map(({ hit: _hit, ...rest }) => rest as T);
    try {
      const picked = await this.refByXPath(pickedNode);
      if (!picked) return unknown();
      let within: ElementRef | undefined;
      if (scope === 'item') {
        const holder = containerNode ? await this.refByXPath(containerNode) : null;
        if (!holder) return unknown();
        for (const c of containers) {
          if (await this.session.same(c, holder)) {
            within = c;
            break;
          }
        }
        if (!within) return unknown();
      }
      const out: T[] = [];
      for (const c of candidates) {
        let first: ElementRef | undefined;
        try {
          [first] = await this.session.resolve(bare(c), within);
        } catch {
          // An invalid selector matches nothing: a miss.
        }
        out.push({ ...c, hit: first ? await this.session.same(first, picked) : false });
      }
      return out;
    } catch {
      return unknown();
    }
  }

  /** The live element for a snapshot node through its positional XPath, when that matches exactly one element. */
  private async refByXPath(node: AnnotatedNode): Promise<ElementRef | null> {
    const xpath = generate(node).find((c) => c.strategy === 'xpath');
    if (!xpath) return null;
    const refs = await this.session.resolve(bare(xpath));
    return refs.length === 1 ? refs[0]! : null;
  }

  /**
   * Candidates for a pick inside an item container, relative to the
   * container element. Candidates generated here carry the element each
   * segment stands for, so the cut falls at the container itself; others
   * (from the page) are cut by selector text.
   */
  private relativeTo(node: AnnotatedNode, containerNode: AnnotatedNode, extra: readonly Candidate[] = []): Candidate[] {
    const fresh = generate(node);
    const keys = new Set(fresh.map((c) => c.strategy));
    const all = [...fresh, ...extra.filter((c) => !keys.has(c.strategy))];
    return dedupe(all.map((c) => relativize(c, containerNode)).filter((c): c is Candidate => c !== null));
  }

  /** Make table `index` active. The selection, proposal, and any field edit belong to the previous table and end. */
  private activate(index: number): void {
    if (!this.draft.tables[index]) throw new Error(`no table at index ${index}`);
    if (index === this.draft.activeTable) return;
    this.clearSelection();
    this.current = { ...this.current, repick: null, repickStep: null };
    this.apply({ type: 'selectTable', index });
  }

  /**
   * Recompute the selection for another table (null: a new one): item scope
   * with candidates relative to the container holding the element when the
   * table has containers and one holds it, else page scope with document
   * candidates.
   */
  private async retarget(table: number | null): Promise<void> {
    const selected = this.current.selected;
    const node = this.node;
    const root = this.root;
    if (!selected || !node || !root) throw new Error('select an element first');
    if (table !== null && !this.draft.tables[table]) throw new Error(`no table at index ${table}`);
    const item = table === null ? null : this.draft.tables[table]!.item;
    let scope: FieldScope = 'page';
    let candidates: ProtocolCandidate[] = [];
    let containerPath: number[] | null = null;
    if (item) {
      const containers = await this.containersOf(item);
      const holder = (await this.nodesFor(containers, root)).find((c) => c !== node && isInside(node, c));
      if (holder) {
        candidates = rank(await this.withCounts(this.relativeTo(node, holder), 'item', containers, true), { itemCount: containers.length });
        if (candidates.length > 0) {
          scope = 'item';
          containerPath = pathOf(holder);
        }
      }
    }
    if (scope === 'page') candidates = rank(await this.withCounts(dedupe(generate(node)), 'page', []));
    this.current = {
      ...this.current,
      selected: {
        ...selected,
        scope,
        primary: 0,
        table,
        selection: { ...selected.selection, candidates, containerPath },
        frameRefusal: this.frameRefusal(table, selected.selection.frame),
      },
    };
    if (!this.current.editing) await this.classify();
  }

  private resetEdits(): void {
    this.edits = { within: null, item: null, withinCleared: false, withinInferred: false, includeAll: false };
  }

  private dropProposal(): void {
    this.proposal = null;
    this.origin = 'pick';
    this.resetEdits();
    this.current = { ...this.current, proposal: null, levelPick: null };
  }

  /** Back to the empty state: no selection, proposal, typed selector, or field edit. The draft does not change. */
  private clearSelection(): void {
    this.node = null;
    this.root = null;
    this.typed = null;
    this.editSeed = null;
    this.handPicked = false;
    this.dropProposal();
    this.current = { ...this.current, selected: null, editing: null, pendingSelect: null, selectorError: null, notice: null };
  }

  private notEditing(): void {
    if (this.current.editing) throw new Error('finish editing the field first: update or cancel it');
  }

  /** Tabs, the table menu, and field edits wait while the list setup is open. */
  private notEditingItem(): void {
    if (this.current.proposal) throw new Error('finish the list setup first: accept or cancel it');
  }

  /**
   * Reopen the confirmed item as a proposal on a fresh snapshot: the list
   * parent and the first container resolved on the page, inferred again with
   * both fixed, seeded with the item's exclusions. The pick stands in as the
   * first item field's element in that container, else the container itself.
   */
  private async editItem(snapshot?: SerializedElement): Promise<void> {
    this.notEditing();
    const item = this.table().item;
    if (!item) throw new Error('no item container to edit');
    this.clearSelection();
    const root = annotate(snapshot ?? ((await this.session.snapshot()) as SerializedElement));
    const parentRef = await listParent(this.session, item.within?.map(bare));
    const [containerRef] = parentRef === null ? [] : await this.containers();
    const [containerNode] = containerRef ? await this.nodesFor([containerRef], root) : [];
    if (!containerRef || !containerNode) throw new Error('the item container matches nothing on this page: remove it and pick again');
    const [withinNode] = parentRef ? await this.nodesFor([parentRef], root) : [];
    const listRoot = withinNode ?? root.children.find((c): c is AnnotatedNode => c.type === 'element' && c.tag === 'body') ?? root;

    let seed: AnnotatedNode = containerNode;
    const field = this.table().fields.find((f) => f.scope === 'item');
    if (field) {
      try {
        const [ref] = await this.session.resolve(bare(field.selectors[0]!), containerRef);
        const [node] = ref ? await this.nodesFor([ref], containerNode) : [];
        if (node && isInside(node, containerNode)) seed = node;
      } catch {
        // An invalid saved selector: the container stands in for the pick.
      }
    }

    const inferred = isInside(containerNode, listRoot) && containerNode !== listRoot ? inferItems(seed, { within: listRoot, item: containerNode }) : null;
    this.proposal = inferred ?? {
      container: containerNode,
      siblings: [containerNode],
      all: [containerNode],
      skipped: [],
      within: withinNode ?? null,
    };
    this.node = seed;
    this.root = root;
    this.origin = 'edit';
    this.resetEdits();
    this.edits = { ...this.edits, withinInferred: !!item.withinInferred && !!withinNode };
    await this.showProposal();
    const view: ProposalView = { ...this.current.proposal!, previousCount: item.count, exclude: item.exclude };
    this.current = { ...this.current, proposal: await this.finishView(view) };
  }

  /**
   * Resolve a candidate by scope: inside each item container for `item`,
   * else on the page. Throws for an invalid selector.
   */
  private async locate(candidate: Candidate, scope: FieldScope, containers: readonly ElementRef[]): Promise<{ count: number; items: number; first: ElementRef | null }> {
    if (scope === 'page') {
      const refs = await this.session.resolve(bare(candidate));
      return { count: refs.length, items: 0, first: refs[0] ?? null };
    }
    let count = 0;
    let items = 0;
    let first: ElementRef | null = null;
    for (const container of containers) {
      const refs = await this.session.resolve(bare(candidate), container);
      count += refs.length;
      if (refs.length > 0) items++;
      first ??= refs[0] ?? null;
    }
    return { count, items, first };
  }

  /** Path of a live element in a page snapshot (the page's when sent, else a fresh one), or null. */
  private async pathFor(ref: ElementRef, snapshot: SerializedElement | undefined): Promise<number[] | null> {
    const root = annotate(snapshot ?? ((await this.session.snapshot()) as SerializedElement));
    const [node] = await this.nodesFor([ref], root);
    return node ? pathOf(node) : null;
  }

  /**
   * Select by typed selector text. On a match the host asks the page to
   * select the first match, and `select` puts the typed candidate first. A
   * refused text shows its reason and keeps the previous selection.
   */
  private async setSelector(selector: string, scopeHint: FieldScope | undefined, snapshot: SerializedElement | undefined): Promise<void> {
    const refuse = (message: string) => {
      this.current = { ...this.current, selectorError: message };
    };
    const text = selector.trim();
    if (!text) return refuse('type a selector');
    const scope: FieldScope = scopeHint ?? this.current.editing?.options.scope ?? this.current.selected?.scope ?? (this.table().item ? 'item' : 'page');
    const candidate = parseSelector(text);
    const containers = scope === 'item' ? await this.targetContainers() : [];
    if (scope === 'item' && containers.length === 0) return refuse('no item container on this page to search in');
    let found: Awaited<ReturnType<RecorderController['locate']>>;
    try {
      found = await this.locate(candidate, scope, containers);
    } catch (error) {
      return refuse(`invalid selector "${text}": ${(error as Error).message.split('\n')[0]}`);
    }
    if (!found.first) return refuse(`"${text}" matches nothing${scope === 'item' ? ' inside the item containers' : ' on this page'}`);
    const path = await this.pathFor(found.first, snapshot);
    if (!path) return refuse(`"${text}" matches an element that is not in the page snapshot`);
    this.typed = { candidate: { ...candidate, count: found.count, ...(scope === 'item' ? { items: found.items } : {}) }, scope };
    this.current = { ...this.current, pendingSelect: { path }, selectorError: null };
  }

  /**
   * Open a saved field in the selection panel. Its saved candidates are
   * counted, and the page is asked to select the primary's first match.
   * With no match the panel shows the saved values and no selected element.
   */
  private async editField(index: number, snapshot: SerializedElement | undefined): Promise<void> {
    const field = this.table().fields[index];
    if (!field) throw new Error(`no field at index ${index}`);
    this.clearSelection();
    const containers = field.scope === 'item' ? await this.containers() : [];
    const candidates = await this.withCounts(field.selectors.map(bare), field.scope, containers, true);
    let first: ElementRef | null = null;
    try {
      first = (await this.locate(field.selectors[0]!, field.scope, containers)).first;
    } catch {
      // An invalid saved selector matches nothing.
    }
    const path = first ? await this.pathFor(first, snapshot) : null;
    this.editSeed = path ? candidates : null;
    this.current = {
      ...this.current,
      repick: null,
      repickStep: null,
      editing: {
        index,
        options: {
          name: field.name,
          type: field.type,
          scope: field.scope,
          ...(field.attr ? { attr: field.attr } : {}),
          optional: field.optional,
          key: field.key,
          hover: field.hover ?? false,
        },
        candidates,
        primary: 0,
      },
      pendingSelect: path ? { path } : null,
    };
  }

  /** Replace the edited field in place with the form's options and the chosen candidates, then clear the selection. */
  private async updateEditedField(patch: FieldPatch): Promise<void> {
    const editing = this.current.editing;
    if (!editing) throw new Error('no field is being edited');
    const field = this.table().fields[editing.index];
    if (!field) throw new Error(`no field at index ${editing.index}`);
    const selected = this.current.selected;
    // Without a selected element the saved candidates all stay, the chosen one first.
    const selectors = selected ? orderForSave(selected.selection.candidates, selected.primary) : toFront(editing.candidates, editing.primary);
    if (selectors.length === 0) throw new Error('the selection has no selector candidates');
    const type = patch.type ?? field.type;
    const attr = patch.attr === null || patch.attr === '' ? undefined : (patch.attr ?? field.attr);
    const scope = patch.scope ?? selected?.scope ?? field.scope;
    const containers = scope === 'item' ? await this.containers() : [];
    const count = selectors[0]!.count ?? null;
    const sample = count ? await this.sample({ selectors, type, scope, ...(attr ? { attr } : {}) }, containers) : null;
    const fp = selected?.selection.fingerprint ?? field.fingerprint;
    const coverage = await this.coverageOf(scope, selectors[0]!, containers);
    this.apply({
      type: 'replaceField',
      index: editing.index,
      field: {
        name: patch.name?.trim() || field.name,
        type,
        scope,
        selectors,
        ...(attr ? { attr } : {}),
        optional: patch.optional ?? field.optional,
        key: patch.key ?? field.key,
        fallback: patch.fallback ?? field.fallback ?? false,
        hover: patch.hover ?? field.hover ?? false,
        ...(fp ? { fingerprint: fp } : {}),
        count,
        coverage,
        sample,
      },
    });
    this.clearSelection();
  }

  /** The list parent in effect for the proposal, or null when there is none or it was cleared. */
  private proposalWithin(): AnnotatedNode | null {
    return this.edits.withinCleared ? null : (this.proposal?.within ?? null);
  }

  private async refOf(node: AnnotatedNode | null): Promise<ElementRef | undefined> {
    if (!node) return undefined;
    try {
      return (await refForNode(this.session, node)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Rebuild the proposal view from the inferred proposal and the edits, keeping exclusions and primaries. */
  private async showProposal(error: ProposalView['error'] = null): Promise<void> {
    const p = this.proposal;
    if (!p) return;
    const previous = this.current.proposal;
    const withinNode = this.proposalWithin();
    const withinRef = await this.refOf(withinNode);
    const items = this.edits.includeAll ? p.all : p.siblings;
    const parent = withinNode && withinRef ? { node: withinNode, ref: withinRef } : null;
    const proposed = p.container ? await this.levelView({ node: p.container, items }, parent, this.edits.item) : { view: EMPTY_LEVEL, fellBack: false };
    let view: ProposalView = {
      within: withinNode ? await this.withinView(withinNode, this.edits.within) : null,
      withinInferred: withinNode !== null && this.edits.withinInferred,
      proposed: proposed.view,
      skipped: this.edits.includeAll ? 0 : p.skipped.length,
      includeAll: this.edits.includeAll,
      error:
        error ??
        (proposed.fellBack
          ? { level: 'item', message: 'no item container selector matches inside the list parent; showing selectors for the whole page' }
          : null),
      exclude: previous?.exclude ?? [],
      origin: this.origin,
      previousCount: previous?.previousCount ?? null,
      pick: null,
      itemLadder: null,
      parentLadder: null,
      fieldPreview: [],
    };
    view = await this.finishView(view);
    // Open ladders follow the new levels.
    if (previous?.itemLadder) view = { ...view, itemLadder: await this.itemLadder() };
    if (previous?.parentLadder) view = { ...view, parentLadder: await this.parentLadder() };
    this.current = { ...this.current, proposal: view };
  }

  /** Recount with the pending exclusions, then read the pick and, while editing, the fields inside the proposed containers. */
  private async finishView(view: ProposalView): Promise<ProposalView> {
    const counted = view.exclude.length > 0 ? await this.recountProposal(view) : view;
    const containers = await this.proposalContainers(counted);
    let pick: ProposalView['pick'] = null;
    const node = this.origin === 'pick' ? this.node : null;
    const holder = node ? this.holderOf(node) : null;
    if (node && holder) {
      const [top] = rank(await this.withCounts<ProtocolCandidate>(this.relativeTo(node, holder), 'item', containers, true), { itemCount: containers.length });
      pick = { selector: top ?? null, matched: top?.items ?? 0, total: containers.length };
    }
    const fieldPreview: ProposalView['fieldPreview'] = [];
    if (this.origin === 'edit') {
      for (const field of this.table().fields) {
        if (field.scope !== 'item') continue;
        const { items } = await this.countIn(field.selectors[0]!, containers);
        if (items < containers.length) fieldPreview.push({ name: field.name, matched: items, total: containers.length });
      }
    }
    return { ...counted, pick, fieldPreview };
  }

  /** The proposed item container holding a node (not the node itself), among the items in effect. */
  private holderOf(node: AnnotatedNode): AnnotatedNode | null {
    const p = this.proposal;
    if (!p?.container) return null;
    const items = this.edits.includeAll ? p.all : p.siblings;
    return [p.container, ...items].find((c) => c !== node && isInside(node, c)) ?? null;
  }

  /** Live containers of the proposal's item level: its primary resolved inside the list parent, less the exclusions. */
  private async proposalContainers(view: ProposalView): Promise<ElementRef[]> {
    const primary = view.proposed.selectors[view.proposed.primary];
    if (!primary) return [];
    try {
      const refs = await this.session.resolve(bare(primary), await this.refOf(this.proposalWithin()));
      return await excludeContainers(this.session, refs, view.exclude.map(bare));
    } catch {
      return [];
    }
  }

  /**
   * "Adjust item level": the pick (or, without one, the item container) and
   * its ancestors below the list parent, each with its top candidate counted
   * inside the list parent. A level matching the same elements as a level
   * above it (the same live elements, or single-child wrappers with the same
   * count) is folded into the highest such level. The pick itself is never
   * folded.
   */
  private async itemLadder(): Promise<ItemLadderRow[]> {
    const p = this.proposal;
    const start = this.origin === 'pick' && this.node ? this.node : (p?.container ?? null);
    if (!p || !start) return [];
    const within = this.proposalWithin();
    const withinRef = await this.refOf(within);
    const parent = within && withinRef ? { node: within, ref: withinRef } : null;
    const rows: ItemLadderRow[] = [];
    const sets: ElementRef[][] = [];
    const nodes: AnnotatedNode[] = [];
    let distance = 0;
    for (let cur: AnnotatedNode | null | undefined = start; cur && cur !== within && !TOP.has(cur.tag) && rows.length < MAX_LADDER; cur = cur.parent, distance++) {
      const { selectors } = await this.itemCandidates(cur, parent);
      const top = selectors.find((c) => (c.count ?? 0) > 0) ?? null;
      let refs: ElementRef[] = [];
      if (top) {
        try {
          refs = await this.session.resolve(bare(top), parent?.ref);
        } catch {
          // Counted as nothing.
        }
      }
      rows.push({ distance, path: pathOf(cur), selector: top, count: refs.length, likely: cur === p.container, sameAs: null });
      sets.push(refs);
      nodes.push(cur);
    }
    const first = this.origin === 'pick' ? 1 : 0;
    for (let i = first; i < rows.length; i++) {
      if (rows[i]!.count === 0) continue;
      let upper = -1;
      // Single-child wrappers: every step up to the upper level has one element child.
      for (let j = i + 1; j < rows.length && elementChildren(nodes[j]!).length === 1 && rows[j]!.count === rows[i]!.count; j++) upper = j;
      for (let j = rows.length - 1; upper === -1 && j > i; j--) if (await this.sameRefs(sets[i]!, sets[j]!)) upper = j;
      if (upper !== -1) rows[i] = { ...rows[i]!, sameAs: rows[upper]!.distance };
    }
    return rows;
  }

  private async sameRefs(a: readonly ElementRef[], b: readonly ElementRef[]): Promise<boolean> {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!(await this.session.same(a[i]!, b[i]!))) return false;
    return true;
  }

  /** "Adjust list parent": the ancestors of the item container, each with the number of children like the item. */
  private async parentLadder(): Promise<ParentLadderRow[]> {
    const container = this.proposal?.container;
    if (!container) return [];
    const within = this.proposalWithin();
    const rows: ParentLadderRow[] = [];
    let distance = 1;
    for (let cur = container.parent; cur && !TOP.has(cur.tag) && rows.length < MAX_LADDER; cur = cur.parent, distance++) {
      const [top] = await this.withinCandidates(cur);
      rows.push({ distance, path: pathOf(cur), selector: top ?? null, children: likeItem(cur, container), likely: cur === within });
    }
    return rows;
  }

  /** Counts inside the list parent, else on the page. */
  private async countWithin(candidates: readonly Candidate[], withinRef: ElementRef | undefined): Promise<Candidate[]> {
    return withinRef ? this.withCounts(candidates, 'item', [withinRef]) : this.withCounts(candidates, 'page', []);
  }

  /**
   * Candidates for an item container level, relative to the list parent when
   * there is one and counted inside it. When no relative candidate matches
   * there, the level falls back to document relative candidates counted on
   * the page, and `fellBack` says so.
   */
  private async itemCandidates(
    node: AnnotatedNode,
    parent: { node: AnnotatedNode; ref: ElementRef } | null,
    itemCount?: number,
  ): Promise<{ selectors: Candidate[]; fellBack: boolean }> {
    const generated = generate(node, { positional: false, level: true });
    if (!parent) return { selectors: rank(await this.countWithin(generated, undefined), { itemCount }), fellBack: false };
    const relative = dedupe(generated.map((c) => relativize(c, parent.node, { anchor: true })).filter((c): c is Candidate => c !== null));
    const ranked = rank(await this.countWithin(relative, parent.ref), { itemCount });
    if (ranked.some((c) => (c.count ?? 0) > 0)) return { selectors: ranked, fellBack: false };
    return { selectors: rank(await this.countWithin(generated, undefined), { itemCount }), fellBack: true };
  }

  private async levelView(
    level: ItemLevel,
    parent: { node: AnnotatedNode; ref: ElementRef } | null,
    typed?: Candidate | null,
  ): Promise<{ view: LevelView; fellBack: boolean }> {
    const { selectors: ranked, fellBack } = await this.itemCandidates(level.node, parent, level.items.length);
    const selectors = typed
      ? [...(await this.countWithin([typed], parent?.ref)), ...ranked.filter((c) => c.strategy !== typed.strategy || c.value !== typed.value)]
      : ranked;
    const view: LevelView = {
      tag: level.node.tag,
      label: levelLabel(level.node),
      path: pathOf(level.node),
      selectors,
      primary: 0,
      count: selectors[0]?.count ?? null,
      total: selectors[0]?.count ?? null,
      paths: level.items.map(pathOf),
      samples: level.items.slice(0, 3).map((n) => sampleOf(n)),
    };
    return { view, fellBack };
  }

  /**
   * Candidates for the list parent, ranked: only those whose first match is
   * the element itself, since the runner uses the first match. A typed
   * selector comes first.
   */
  private async withinCandidates(node: AnnotatedNode, typed?: Candidate | null): Promise<Candidate[]> {
    const ref = await this.refOf(node);
    const kept: Candidate[] = [];
    for (const c of generate(node, { level: true })) {
      let refs: ElementRef[];
      try {
        refs = await this.session.resolve(bare(c));
      } catch {
        continue;
      }
      if (refs.length === 0 || (ref && !(await this.session.same(refs[0]!, ref)))) continue;
      kept.push({ ...c, count: refs.length });
    }
    const ranked = rank(kept);
    if (!typed) return ranked;
    const [counted] = await this.withCounts([typed], 'page', []);
    return [counted!, ...ranked.filter((c) => c.strategy !== typed.strategy || c.value !== typed.value)];
  }

  private async withinView(node: AnnotatedNode, typed?: Candidate | null): Promise<LevelView> {
    const selectors = await this.withinCandidates(node, typed);
    return {
      tag: node.tag,
      label: levelLabel(node),
      path: pathOf(node),
      selectors,
      primary: 0,
      count: selectors[0]?.count ?? null,
      total: selectors[0]?.count ?? null,
      paths: [pathOf(node)],
      samples: [],
    };
  }

  /** Snapshot nodes for live elements: same tag, attributes, and leading text, in document order. */
  private async nodesFor(refs: readonly ElementRef[], root: AnnotatedNode): Promise<AnnotatedNode[]> {
    const pool = descendantsOf(root);
    const used = new Set<AnnotatedNode>();
    const lead = (el: SerializedElement) => normalize(textContent(el)).slice(0, 100);
    const out: AnnotatedNode[] = [];
    for (const ref of refs) {
      const snap = await this.session.snapshot(ref);
      if (snap.type !== 'element') continue;
      const keys = Object.keys(snap.attrs);
      const text = lead(snap);
      const hit = pool.find(
        (n) =>
          !used.has(n) &&
          n.tag === snap.tag &&
          Object.keys(n.attrs).length === keys.length &&
          keys.every((k) => n.attrs[k] === snap.attrs[k]) &&
          lead(n) === text,
      );
      if (hit) {
        used.add(hit);
        out.push(hit);
      }
    }
    return out;
  }

  /** Which elements a click may set while picking a proposal field or the confirmed item's list parent. */
  private levelPickFor(level: LevelKind): LevelPick {
    const view = this.current.proposal;
    if (view && this.proposal) {
      const container = this.proposal.container;
      if (level === 'within') return { level, ancestorOf: container ? [pathOf(container)] : [], ofContainers: false, descendantOf: null, containing: null };
      const within = this.proposalWithin();
      const pick = this.origin === 'pick' ? this.node : null;
      return { level, ancestorOf: [], ofContainers: false, descendantOf: within ? pathOf(within) : null, containing: pick ? pathOf(pick) : null };
    }
    if (this.table().item && level === 'within') return { level, ancestorOf: [], ofContainers: true, descendantOf: null, containing: null };
    throw new Error(level === 'within' ? 'set an item container before its list parent' : 'no item proposal to change');
  }

  private async setLevel(
    level: LevelKind,
    by: 'pick' | 'selector' | 'clear' | 'path',
    msg: { path?: number[] | undefined; selector?: string | undefined; snapshot?: SerializedElement | undefined },
  ): Promise<void> {
    this.current = { ...this.current, levelPick: null };
    if (this.proposal && this.current.proposal) return this.editProposal(level, by === 'path' ? 'pick' : by, msg);
    if (this.table().item && level === 'within') return this.editItemWithin(by === 'path' ? 'pick' : by, msg);
    throw new Error(level === 'within' ? 'set an item container before its list parent' : 'no item proposal to change');
  }

  /**
   * Edit a proposal field; a refused edit shows its reason and keeps the
   * previous value. With a pick, the item must hold it and the list parent
   * must hold the item. Without one (manual, edit), the item may be any
   * element inside the list parent (or the page), and the list parent any
   * element while no item is set.
   */
  private async editProposal(
    level: LevelKind,
    by: 'pick' | 'selector' | 'clear',
    msg: { path?: number[] | undefined; selector?: string | undefined },
  ): Promise<void> {
    const p = this.proposal!;
    const pick = this.origin === 'pick' ? this.node : null;
    const root = this.root!;
    const body = root.children.find((c): c is AnnotatedNode => c.type === 'element' && c.tag === 'body') ?? root;
    const refuse = (message: string) => {
      this.current = { ...this.current, proposal: { ...this.current.proposal!, error: { level, message } } };
    };
    /** A new list parent: items inferred again from the pick, else the item level kept. */
    const setWithin = (node: AnnotatedNode, typed: Candidate | null, name: string): string | null => {
      const held = p.container ?? pick;
      if (!held) {
        this.proposal = { ...p, within: node };
      } else {
        if (node === held || !isInside(held, node)) return `outside the list: ${name}`;
        const next = pick ? inferItems(pick, { within: node }) : inferItems(held, { within: node, item: held });
        if (!next) return 'no items like the picked one inside that element';
        this.proposal = next;
      }
      this.edits = { ...this.edits, within: typed, item: null, withinCleared: false, withinInferred: false };
      return null;
    };
    if (by === 'clear') {
      if (level === 'item') return refuse('the item container cannot be empty; cancel the list setup instead');
      this.edits = { ...this.edits, within: null, withinCleared: true, withinInferred: false };
      return this.showProposal();
    }
    if (by === 'pick') {
      const node = msg.path ? nodeAt(root, msg.path) : null;
      if (!node) return refuse('the picked element is not in the page snapshot');
      if (level === 'within') {
        if (TOP.has(node.tag)) return refuse('outside the list: pick an element that holds the item');
        const why = setWithin(node, null, 'pick an element that holds the item');
        return why ? refuse(why) : this.showProposal();
      }
      const listRoot = this.proposalWithin() ?? body;
      if (TOP.has(node.tag) || node === listRoot || !isInside(node, listRoot)) return refuse('outside the list: pick an element inside the list parent');
      if (pick && !isInside(pick, node)) return refuse('pick an element that holds the selected element');
      const next = inferItems(pick ?? node, { within: listRoot, item: node }) ?? (pick ? null : { container: node, siblings: [node], all: [node], skipped: [], within: null });
      if (!next) return refuse('no items at that level');
      this.proposal = { ...next, within: p.within };
      this.edits = { ...this.edits, item: null };
      return this.inferWithin(body);
    }
    const text = (msg.selector ?? '').trim();
    if (!text) return refuse('type a selector');
    const candidate = parseSelector(text);
    let refs: ElementRef[];
    const within = this.proposalWithin();
    const withinRef = level === 'item' ? await this.refOf(within) : undefined;
    try {
      refs = await this.session.resolve(bare(candidate), withinRef);
    } catch (error) {
      return refuse(`invalid selector "${text}": ${(error as Error).message.split('\n')[0]}`);
    }
    if (refs.length === 0 && level === 'within') {
      // The setup shows the typed list parent with 0 items and refuses Accept; the next edit starts from the inferred list again.
      const view = this.current.proposal!;
      const within: LevelView = { tag: '', label: text, path: [], selectors: [{ ...candidate, count: 0 }], primary: 0, count: 0, total: 0, paths: [], samples: [] };
      this.current = {
        ...this.current,
        proposal: { ...view, within, withinInferred: false, proposed: { ...view.proposed, count: 0, total: 0, paths: [], samples: [] }, pick: null, error: { level, message: 'list parent matches nothing' } },
      };
      return;
    }
    if (refs.length === 0) return refuse(`"${text}" matches nothing${withinRef ? ' inside the list parent' : ''}`);
    if (level === 'within') {
      const [node] = await this.nodesFor([refs[0]!], root);
      if (!node) return refuse(`"${text}" matches an element that is not in the page snapshot`);
      if (TOP.has(node.tag)) return refuse('outside the list: the list parent must hold the item');
      const why = setWithin(node, candidate, pick ? 'the list parent must hold the selected element' : 'the list parent must hold the item');
      return why ? refuse(why) : this.showProposal();
    }
    const nodes = await this.nodesFor(refs, within ?? root);
    const container = (pick ? nodes.find((n) => isInside(pick, n)) : undefined) ?? nodes[0];
    if (!container) return refuse(`"${text}" matches elements that are not in the page snapshot`);
    this.proposal = { ...p, container, siblings: nodes, all: nodes, skipped: [] };
    this.edits = { ...this.edits, item: candidate };
    return this.inferWithin(body);
  }

  /**
   * Show the proposal after an item level edit. A manual setup with no list
   * parent (and none cleared by the user) gets one inferred: the nearest
   * common ancestor of the matched containers below `body`, kept only when
   * the item count stays the same relative to it.
   */
  private async inferWithin(body: AnnotatedNode): Promise<void> {
    await this.showProposal();
    const p = this.proposal!;
    if (this.origin !== 'manual' || p.within || this.edits.withinCleared || !p.container) return;
    const before = this.current.proposal!;
    if (!before.proposed.count) return;
    const items = this.edits.includeAll ? p.all : p.siblings;
    const ancestor = commonAncestor([p.container, ...items]);
    if (!ancestor || ancestor === body || TOP.has(ancestor.tag) || !isInside(ancestor, body)) return;
    this.proposal = { ...p, within: ancestor };
    this.edits = { ...this.edits, withinInferred: true };
    await this.showProposal();
    const after = this.current.proposal!;
    if (after.proposed.count === before.proposed.count && !after.error) return;
    this.proposal = p;
    this.edits = { ...this.edits, withinInferred: false };
    this.current = { ...this.current, proposal: before };
  }

  /** Set, re-pick, or clear the list parent of the confirmed item container, rewriting the item selectors relative to it. */
  private async editItemWithin(by: 'pick' | 'selector' | 'clear', msg: { path?: number[] | undefined; selector?: string | undefined; snapshot?: SerializedElement | undefined }): Promise<void> {
    if (by === 'clear') {
      const root = msg.snapshot ? annotate(msg.snapshot) : annotate((await this.session.snapshot()) as SerializedElement);
      const selectors = await this.rewriteItem(root, null);
      this.replaceItemSelectors(selectors);
      this.apply({ type: 'setWithin', within: null });
      await this.recount();
      return;
    }
    const root = msg.snapshot ? annotate(msg.snapshot) : (this.root ?? annotate((await this.session.snapshot()) as SerializedElement));
    let node: AnnotatedNode | null | undefined;
    let typed: Candidate | null = null;
    if (by === 'pick') {
      node = msg.path ? nodeAt(root, msg.path) : null;
      if (!node) throw new Error('the picked element is not in the page snapshot');
    } else {
      const text = (msg.selector ?? '').trim();
      typed = parseSelector(text);
      const refs = await this.session.resolve(bare(typed));
      if (refs.length === 0) throw new Error(`"${text}" matches nothing`);
      [node] = await this.nodesFor([refs[0]!], root);
      if (!node) throw new Error(`"${text}" matches an element that is not in the page snapshot`);
    }
    if (TOP.has(node.tag)) throw new Error('outside the list: pick an element that holds the items');
    const ref = await this.refOf(node);
    if (!ref) throw new Error('the picked element is not on the page');
    const item = await this.rewriteItem(root, { node, ref });
    const selectors = orderForSave(await this.withinCandidates(node, typed), 0);
    if (selectors.length === 0) throw new Error('found no selector for that element');
    this.replaceItemSelectors(item);
    this.apply({ type: 'setWithin', within: selectors, fingerprint: fingerprint(node) });
    await this.recount();
  }

  private replaceItemSelectors(selectors: ProtocolCandidate[]): void {
    const { count: _c, total: _t, ...rest } = this.table().item!;
    this.apply({ type: 'setItem', item: { ...rest, selectors, count: null, total: null } });
  }

  /**
   * Item container selectors for a new list parent (or the document, for
   * null): regenerated for the first current container inside it, relative to
   * it, and counted there. The old primary selector stays first when its
   * relative form still finds that container.
   */
  private async rewriteItem(root: AnnotatedNode, parent: { node: AnnotatedNode; ref: ElementRef } | null): Promise<ProtocolCandidate[]> {
    const item = this.table().item!;
    const current = await this.containers();
    let first: { node: AnnotatedNode; ref: ElementRef } | null = null;
    for (const ref of current) {
      const [node] = await this.nodesFor([ref], root);
      if (node && (!parent || (node !== parent.node && isInside(node, parent.node)))) {
        first = { node, ref };
        break;
      }
    }
    if (!first) {
      throw new Error(parent ? 'outside the list: that element holds none of the item containers' : 'found no item container on the page');
    }
    const { selectors: ranked, fellBack } = await this.itemCandidates(first.node, parent, current.length);
    if (fellBack) throw new Error('no item container selector matches inside that element');
    const old = item.selectors[0]!;
    const relative = parent ? relativize(old, parent.node, { anchor: true }) : bare(old);
    if (relative && !ranked.some((c) => c.strategy === relative.strategy && c.value === relative.value)) {
      let refs: ElementRef[] = [];
      try {
        refs = await this.session.resolve(bare(relative), parent?.ref);
      } catch {
        // Not valid in this scope; the regenerated candidates stand.
      }
      // Same item set as the best regenerated candidate, and it finds the container.
      let holds = refs.length > 0 && refs.length === ranked[0]?.count;
      if (holds) {
        holds = false;
        for (const r of refs) if ((holds = await this.session.same(r, first.ref))) break;
      }
      if (holds) return orderForSave([{ ...relative, count: refs.length }, ...ranked], 0);
    }
    const kept = relative ? ranked.findIndex((c) => c.strategy === relative.strategy && c.value === relative.value) : -1;
    const same = kept === -1 ? ranked.findIndex((c) => c.strategy === old.strategy && c.count === ranked[0]?.count) : kept;
    return orderForSave(same > 0 ? toFront(ranked, same) : ranked, 0);
  }

  private async setPrimary(level: LevelKind, index: number): Promise<void> {
    const view = this.current.proposal;
    if (view && this.proposal) {
      const target = level === 'within' ? view.within : view.proposed;
      if (!target || !target.selectors[index]) throw new Error(`no candidate at index ${index}`);
      const updated = { ...target, primary: index, count: target.selectors[index].count ?? null, total: target.selectors[index].count ?? null };
      this.current = { ...this.current, proposal: await this.finishView(level === 'within' ? { ...view, within: updated } : { ...view, proposed: updated }) };
      return;
    }
    const item = this.table().item;
    if (!item) throw new Error('no item container to change');
    if (level === 'within') {
      if (!item.within) throw new Error('the item container has no list parent');
      this.apply({
        type: 'setWithin',
        within: toFront(item.within, index),
        ...(item.withinFingerprint ? { fingerprint: item.withinFingerprint } : {}),
        ...(item.withinInferred ? { inferred: true } : {}),
      });
    } else {
      const { count: _c, total: _t, ...rest } = item;
      this.apply({ type: 'setItem', item: { ...rest, selectors: toFront(item.selectors, index), count: null, total: null } });
    }
    await this.recount();
  }

  /**
   * Accept the list setup: set the item container, list parent, and
   * exclusions. An edit returns to the empty state. A pick inside the new
   * containers comes back item scoped, ready to add; otherwise the Pick
   * section says the list is ready. No field is added.
   */
  private async confirmItems(): Promise<void> {
    const proposal = this.current.proposal;
    const containerNode = this.proposal?.container;
    if (!proposal) throw new Error('no list setup to accept');
    if (!containerNode || !proposal.proposed.count) throw new Error('the item container matches nothing: pick or type one first');
    const view = proposal.proposed;
    const selectors = orderForSave(view.selectors, view.primary);
    const exclude = proposal.exclude;
    const withinNode = this.proposalWithin();
    const within = proposal.within && withinNode ? orderForSave(proposal.within.selectors, proposal.within.primary) : [];
    const holder = proposal.origin === 'edit' || !this.node ? null : this.holderOf(this.node);
    const origin = proposal.origin;
    const frame = this.scopeFrame();
    if (origin !== 'edit') {
      const refusal = this.frameRefusal(this.draft.activeTable, frame);
      if (refusal) throw new Error(`${refusal}: set up the list inside it, or in another table`);
      if (this.table().fields.length === 0) this.apply({ type: 'setTableFrame', frame });
    }
    this.apply({
      type: 'setItem',
      item: {
        selectors,
        ...(within.length > 0
          ? { within, withinFingerprint: fingerprint(withinNode!), withinCount: null, ...(proposal.withinInferred ? { withinInferred: true } : {}) }
          : {}),
        exclude,
        fingerprint: fingerprint(containerNode),
        count: null,
        total: null,
      },
    });
    this.dropProposal();
    await this.recount();
    this.emitter.emit('recorder.itemsConfirmed', { count: this.table().item!.count, selector: `${selectors[0]!.strategy}=${selectors[0]!.value}` });
    // An edit of the confirmed item keeps the fields as they are; the recount marks the broken ones.
    if (origin === 'edit') return this.clearSelection();

    // The selected element comes back read inside its item.
    const selected = this.current.selected;
    const node = this.node;
    if (selected && node && holder) {
      const containers = await this.containers();
      const relative = this.relativeTo(node, holder, selected.selection.candidates);
      let candidates = await this.withCounts(relative, 'item', containers, true);
      if (candidates.length > 0) {
        if (this.handPicked) candidates = await this.verified(candidates, 'item', node, holder, containers);
        candidates = rank(candidates, { itemCount: containers.length });
        this.current = {
          ...this.current,
          selected: {
            ...selected,
            scope: 'item',
            primary: 0,
            table: this.draft.activeTable,
            selection: { ...selected.selection, candidates, containerPath: pathOf(holder) },
            suggestion: null,
            outside: null,
            belongs: null,
          },
        };
        return;
      }
    }
    this.clearSelection();
    this.current = { ...this.current, notice: LIST_READY };
  }

  private async addExclusion(selector: string): Promise<void> {
    const proposal = this.current.proposal;
    if (!this.table().item && !proposal) throw new Error('find or set an item container before adding an exclusion');
    // Typed as `strategy=value` by the selector input; bare text is CSS.
    const candidate: ProtocolCandidate = parseSelector(selector);
    let matches: number;
    try {
      matches = (await this.session.resolve(candidate)).length;
    } catch (error) {
      throw new Error(`invalid exclusion selector "${selector}": ${(error as Error).message.split('\n')[0]}`, { cause: error });
    }
    if (!proposal) {
      this.apply({ type: 'addExclusion', candidate });
      await this.recount();
      this.emitter.emit('recorder.excluded', { selector: candidate.value, count: this.table().item!.count });
      return;
    }
    const exclude = [...proposal.exclude, { ...candidate, count: matches }];
    this.current = { ...this.current, proposal: await this.finishView({ ...proposal, exclude }) };
    this.emitter.emit('recorder.excluded', { selector: candidate.value, count: this.current.proposal!.proposed.count });
  }

  private async removeExclusion(index: number): Promise<void> {
    const proposal = this.current.proposal;
    if (!proposal) {
      this.apply({ type: 'removeExclusion', index });
      await this.recount();
      return;
    }
    this.current = {
      ...this.current,
      proposal: await this.finishView({ ...proposal, exclude: proposal.exclude.filter((_, i) => i !== index) }),
    };
  }

  /** Recount the item level with the pending exclusions applied. */
  private async recountProposal(proposal: ProposalView): Promise<ProposalView> {
    const view = proposal.proposed;
    const primary = view.selectors[view.primary];
    if (!primary) return proposal;
    const refs = await this.session.resolve(bare(primary), await this.refOf(this.proposalWithin()));
    const kept = await excludeContainers(this.session, refs, proposal.exclude.map(bare));
    return { ...proposal, proposed: { ...view, count: kept.length, total: refs.length } };
  }

  private async addField(patch: FieldPatch): Promise<void> {
    if (!this.current.selected) throw new Error('select an element first');
    if (this.current.proposal) throw new Error('finish the list setup first: accept or cancel it');
    // The target table: the form's, else the one the selection was computed for. It becomes active.
    const target = patch.table ?? this.current.selected.table ?? this.draft.activeTable;
    if (typeof target === 'number') {
      if (!this.draft.tables[target]) throw new Error(`no table at index ${target}`);
      if (target !== this.current.selected.table) await this.retarget(target);
    } else {
      const error = tableNameError(this.draft, target.new.trim());
      if (error) throw new Error(error);
      if (this.current.selected.table !== null) await this.retarget(null);
    }
    const selected = this.current.selected!;
    const refusal = typeof target === 'number' ? this.frameRefusal(target, selected.selection.frame) : null;
    if (refusal) throw new Error(`${refusal}: pick inside it, or add the field to another table`);
    if (selected.outside) throw new Error(`the selection is outside the ${this.draft.tables[selected.outside.table]!.name} list: add it to a page table or re-pick`);
    if (selected.belongs) throw new Error(`the selection belongs to the ${this.draft.tables[selected.belongs.table]!.name} list: switch to it or re-pick`);
    // The scope follows the table's mode, never a choice.
    const into = typeof target === 'number' ? this.draft.tables[target]! : { name: target.new.trim(), item: null, fields: [] };
    const scope = scopeForTable(into);
    if (scope === 'item' && selected.scope !== 'item') throw new Error(`pick inside an item of the ${into.name} list`);
    if (typeof target === 'number') {
      if (target !== this.draft.activeTable) this.apply({ type: 'selectTable', index: target });
    } else {
      this.apply({ type: 'addTable', name: target.new.trim() });
    }
    const selectors = orderForSave(selected.selection.candidates, selected.primary);
    if (selectors.length === 0) throw new Error('the selection has no selector candidates');
    // The first field or item container sets the table's frame.
    if (this.table().fields.length === 0 && !this.table().item) this.apply({ type: 'setTableFrame', frame: selected.selection.frame });
    const type = patch.type ?? selected.defaults.type;
    const attr = patch.attr === null ? undefined : (patch.attr ?? (patch.type && patch.type !== selected.defaults.type ? defaultAttr(type) : selected.defaults.attr));
    const taken = this.table().fields.map((f) => f.name);
    const name = patch.name ?? (taken.includes(selected.defaults.name) ? fieldDefaults({ tag: selected.selection.tag, attrs: selected.selection.attrs, text: selected.selection.text, ...(selected.selection.name ? { name: selected.selection.name } : {}) }, taken).name : selected.defaults.name);
    const containers = scope === 'item' ? await this.containers() : [];
    const sample = await this.sample({ selectors, type, scope, ...(attr ? { attr } : {}) }, containers);
    const coverage = await this.coverageOf(scope, selectors[0]!, containers);
    this.apply({
      type: 'addField',
      field: {
        name,
        type,
        scope,
        selectors,
        ...(attr ? { attr } : {}),
        optional: patch.optional ?? false,
        key: patch.key ?? false,
        fallback: patch.fallback ?? false,
        hover: patch.hover ?? false,
        fingerprint: selected.selection.fingerprint,
        count: selectors[0]!.count ?? null,
        coverage,
        sample,
      },
    });
    this.emitter.emit('recorder.fieldAdded', { name, type, scope, count: selectors[0]!.count ?? null });
    this.clearSelection();
  }

  /**
   * Add a step to a flow (the active one by default). With a selection (browse
   * mode) its candidates are the target; without one (`undefined`) the picked
   * element is; `null` means no target, such as a key press on whatever has
   * focus. A step recorded in a popup acts in the popup.
   */
  private async addStep(step: NewStep, selection: ParsedSelection | null | undefined, flow?: number): Promise<void> {
    let target: { selectors: ProtocolCandidate[]; fingerprint: ParsedSelection['fingerprint']; frame?: FrameTarget } | undefined;
    if (selection) {
      const frame = selection.frame ? await this.verifyFrame(selection.frame) : null;
      target = { selectors: orderForSave(rank(dedupe(selection.candidates)), 0), fingerprint: selection.fingerprint, ...(frame ? { frame } : {}) };
    } else if (selection === undefined) {
      const selected = this.current.selected;
      const node = this.node;
      if (!selected || !node) throw new Error('select an element first');
      const frame = selected.selection.frame;
      // The pick may be item scoped; a step target is always found in the whole document (of its frame).
      const selectors = orderForSave(rank(await this.inFrame(frame, () => this.withCounts(generate(node), 'page', []))), 0);
      target = { selectors, fingerprint: selected.selection.fingerprint, ...(frame ? { frame } : {}) };
    }
    if (target && target.selectors.length === 0) throw new Error('the element has no selector candidates');
    if (flow !== undefined && !this.draft.flows[flow]) throw new Error(`no flow at index ${flow}`);
    const into0 = flow ?? this.draft.activeFlow;
    const steps = into0 !== null && into0 !== undefined ? (this.draft.flows[into0]?.steps ?? []) : [];
    const keyOf = (t: { selectors: ProtocolCandidate[] } | undefined) => (t?.selectors[0] ? `${t.selectors[0].strategy}=${t.selectors[0].value}` : null);
    if (step.replacesClick && steps.at(-1)?.kind === 'click' && into0 !== null && into0 !== undefined) {
      this.apply({ type: 'removeStep', flow: into0, index: steps.length - 1 });
    }
    let value = step.value;
    if (step.kind === 'fill' && step.variable) {
      const path = step.variable.type === 'path';
      const secret = step.variable.secret === true && !path;
      // A fill of the same target right before reuses its variable, so typing a password again does not add one.
      const last = this.draft.flows[into0 ?? -1]?.steps.at(-1);
      const reused = last?.kind === 'fill' && keyOf(last.target) !== null && keyOf(last.target) === keyOf(target) ? /^\{(\w+)\}$/.exec(last.value ?? '')?.[1] : undefined;
      const existing = reused ? this.draft.vars.find((v) => v.name === reused && (v.type === 'path') === path && (v.secret === true) === secret && !v.origin) : undefined;
      const name = existing?.name ?? uniqueVarName(this.draft, step.variable.name, path ? 'file' : secret ? 'password' : 'value');
      const initial = path ? '' : (step.value ?? '');
      if (existing) this.apply({ type: 'setVar', name, value: path ? existing.value : initial });
      else this.apply({ type: 'declareVar', name, value: initial, ...(secret ? { secret: true } : {}), ...(path ? { path: true } : {}) });
      value = `{${name}}`;
      if (path) await this.checkPath(name);
    }
    this.apply({
      type: 'addStep',
      ...(flow !== undefined ? { flow } : {}),
      step: {
        kind: step.kind,
        ...(target ? { target } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(step.until ? { until: step.until } : {}),
        window: this.ownerIsPopup() ? 'popup' : 'same',
        ...(step.optional !== undefined ? { optional: step.optional } : {}),
        count: target?.selectors[0]?.count ?? null,
      },
    });
    const into = flow ?? this.draft.activeFlow ?? this.draft.flows.length - 1;
    const primary = target?.selectors[0];
    this.emitter.emit('recorder.stepAdded', {
      flow: this.draft.flows[into]?.name ?? '',
      index: (this.draft.flows[into]?.steps.length ?? 1) - 1,
      kind: step.kind,
      target: primary ? `${primary.strategy}=${primary.value}` : null,
      ...(value !== undefined ? { value } : {}),
    });
  }

  /** Make a flow reactive with the selected element as its trigger. */
  private async setTrigger(index: number, selection: ParsedSelection): Promise<void> {
    if (!this.draft.flows[index]) throw new Error(`no flow at index ${index}`);
    const frame = selection.frame ? await this.verifyFrame(selection.frame) : null;
    const selectors = orderForSave(rank(dedupe(selection.candidates)), 0);
    if (selectors.length === 0) throw new Error('the element has no selector candidates');
    this.apply({ type: 'setTrigger', index, trigger: { selectors, fingerprint: selection.fingerprint, ...(frame ? { frame } : {}) } });
    this.current = { ...this.current, pickTrigger: null };
  }

  /**
   * Replay one step (`index`), or a whole flow (null), on the live page, the way
   * a run would, and report how it went.
   */
  private async replay(flowIndex: number, index: number | null): Promise<HostMessage> {
    const draftFlow = this.draft.flows[flowIndex];
    if (!draftFlow) throw new Error(`no flow at index ${flowIndex}`);
    if (index !== null) this.stepOf(flowIndex, index);
    const validated = validateRecipe(draftToRecipe(this.draft));
    let ok = false;
    let message: string;
    if (!validated.ok) {
      message = validated.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    } else {
      const flow = validated.recipe.flows[flowIndex]!;
      const only = index === null ? flow : { ...flow, steps: [flow.steps[index]!] };
      const reports: StepReport[] = [];
      try {
        await this.runFlows([only], (report) => reports.push(index === null ? report : { ...report, index }));
        ok = reports.every((r) => r.outcome === 'ok' || r.outcome === 'healed');
        message = describeReplay(flow.name, index, reports);
      } catch (error) {
        message = `${index === null ? `flow ${flow.name}` : `step ${index + 1}`} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    // A step can reveal content without a navigation, such as a consent click: count again.
    if (ok) await this.recount();
    this.emitter.emit('recorder.stepReplayed', { flow: draftFlow.name, index: index ?? -1, kind: index === null ? 'flow' : draftFlow.steps[index]!.kind, ok, message });
    return { kind: 'step.replayResult', index, ok, message, state: this.current };
  }

  /** Replay, in order, the called flows the sequence runs before a table's extract block; the zero-match warning offers it. */
  private async replayFlowsBefore(table: number): Promise<HostMessage> {
    const name = this.draft.tables[table]?.name;
    if (name === undefined) throw new Error(`no table at index ${table}`);
    const names = flowsBefore(draftSequence(this.draft), name);
    const validated = validateRecipe(draftToRecipe(this.draft));
    let ok = false;
    let message: string;
    if (!validated.ok) {
      message = validated.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    } else if (names.length === 0) {
      message = `no flow runs before ${name}`;
    } else {
      const reports: StepReport[] = [];
      try {
        await this.runFlows(names.map((n) => validated.recipe.flows.find((f) => f.name === n)!), (report) => reports.push(report));
        ok = reports.every((r) => r.outcome === 'ok' || r.outcome === 'healed');
        message = ok ? `replayed ${names.join(', ')}` : `replayed ${names.join(', ')} with skipped steps`;
      } catch (error) {
        message = `replaying ${names.join(', ')} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await this.recount();
    return { kind: 'step.replayResult', index: null, ok, message, state: this.current };
  }

  /** Run flows on the live page with the runner's flow executor, in the owner window. */
  private async runFlows(flows: Flow[], onEvent: (report: StepReport) => void): Promise<void> {
    const validated = validateRecipe(draftToRecipe(this.draft));
    if (!validated.ok) throw new Error('the draft does not validate');
    const values = Object.fromEntries(this.draft.vars.filter((v) => v.value !== '').map((v) => [v.name, v.value]));
    const windows = new RunWindows(this.raw);
    const cache = new Map();
    try {
      for (const flow of flows) {
        await runFlow(validated.recipe, flow, this.raw, { page: 1, windows, vars: values, ...(this.opts.files ? { files: this.opts.files } : {}), timeoutMs: this.opts.timeoutMs ?? 30_000, cache, onEvent });
      }
    } finally {
      // Popups a replay opened stay for the user; only the listener goes.
      windows.release();
    }
  }

  private markPagination(): void {
    const selected = this.current.selected;
    if (!selected) throw new Error('select the pagination control first');
    const { selection } = selected;
    const detected = detectPagination(
      { tag: selection.tag, attrs: selection.attrs, ...(selection.role ? { role: selection.role } : {}) },
      this.current.url,
    );
    const previous = this.draft.pagination ?? newPagination(detected.kind);
    const { param: _param, ...rest } = previous;
    this.apply({
      type: 'setPagination',
      pagination: {
        ...rest,
        ...(previous.table ? {} : { table: this.table().name }),
        kind: detected.kind,
        ...(detected.param ? { param: detected.param } : {}),
        target: {
          selectors: orderForSave(selection.candidates, selected.primary),
          fingerprint: selection.fingerprint,
          ...(selection.frame ? { frame: selection.frame } : {}),
        },
      },
    });
    this.emitter.emit('recorder.paginationSet', { kind: detected.kind });
  }

  /**
   * Edit a frame target: make a candidate primary, or put a typed selector
   * first once it matches a same-origin iframe. Every table, step, and
   * pagination target with that frame, and the selection, get the result.
   */
  private async editFrame(key: { strategy: string; value: string }, by: 'primary' | 'selector', index: number | undefined, typed: string | undefined): Promise<void> {
    const id = `${key.strategy}=${key.value}`;
    const isKey = (f: FrameTarget | null | undefined): f is FrameTarget => !!f && `${f.selectors[0]?.strategy}=${f.selectors[0]?.value}` === id;
    const selected = this.current.selected;
    const owned = [
      ...this.draft.tables.map((t) => t.frame),
      ...this.draft.flows.flatMap((f) => [f.trigger?.frame, ...f.steps.map((s) => s.target?.frame)]),
      this.draft.pagination?.target?.frame,
      selected?.selection.frame,
    ];
    const frame = owned.find(isKey);
    if (!frame) throw new Error(`no frame target ${id}`);
    let selectors: ProtocolCandidate[];
    if (by === 'primary') {
      selectors = toFront(frame.selectors, index ?? 0);
    } else {
      const candidate: ProtocolCandidate = parseSelector(typed ?? '');
      let refs: ElementRef[];
      try {
        refs = await this.raw.resolve(bare(candidate));
      } catch (error) {
        throw new Error(`invalid frame selector "${typed}": ${(error as Error).message.split('\n')[0]}`, { cause: error });
      }
      if (refs.length === 0) throw new Error(`no iframe matches ${candidate.strategy}=${candidate.value}`);
      if (!(await this.raw.frameRoot(refs[0]!, { timeoutMs: this.opts.timeoutMs ?? 30_000 }))) {
        throw new Error(`${candidate.strategy}=${candidate.value} does not match a same-origin iframe`);
      }
      selectors = [{ ...candidate, count: refs.length }, ...frame.selectors.filter((c) => !sameSelector(c, candidate))];
    }
    const next: FrameTarget = { ...frame, selectors };
    this.apply({ type: 'replaceFrame', key: id, frame: next });
    if (selected && isKey(selected.selection.frame)) {
      this.current = { ...this.current, selected: { ...selected, selection: { ...selected.selection, frame: next } } };
    }
  }

  // Test run and save --------------------------------------------------------

  /** Run the draft on the current page, page 1 only, with the runner's extraction; one result per table. */
  async testRun(): Promise<TestResults> {
    const started = this.now();
    const validated = validateRecipe(draftToRecipe(this.draft));
    let results: TestResults;
    if (!validated.ok) {
      results = {
        tables: [],
        durationMs: 0,
        warnings: [],
        error: validated.errors.map((e) => `${e.path}: ${e.message}`).join('\n'),
      };
    } else {
      const extracted = (await extractPage(this.raw, validated.recipe, { pageUrl: this.current.url, page: 1, hover: false, frameTimeoutMs: this.opts.timeoutMs ?? 30_000 })).tables;
      const recipeTables = tablesOf(validated.recipe);
      results = {
        tables: extracted.map((extraction, t): TestTable => {
          const causes = new Set(extraction.dropped.flatMap((d) => d.fields));
          const droppedFields = extraction.fields.map((f) => f.name).filter((name) => causes.has(name));
          return {
            name: extraction.name,
            rows: extraction.rows.slice(0, MAX_TEST_ROWS),
            rowCount: extraction.rows.length,
            dropped: { count: extraction.dropped.length, fields: droppedFields },
            fields: extraction.fields.map((f) => ({
              name: f.name,
              status: f.status,
              ...(recipeTables[t]?.fields.find((field) => field.name === f.name)?.hover ? { hover: true } : {}),
            })),
            ...(extraction.missingRequired.length > 0
              ? {
                  error: `required ${
                    extraction.missingRequired.includes('within')
                      ? 'list parent'
                      : extraction.missingRequired.includes('item')
                        ? 'item container'
                        : `field${extraction.missingRequired.length > 1 ? 's' : ''} ${extraction.missingRequired.join(', ')}`
                  } matched no element`,
                }
              : extraction.containerCount > 0 && extraction.rows.length === 0
                ? { error: `every row was dropped for missing required field${droppedFields.length > 1 ? 's' : ''} ${droppedFields.join(', ')}` }
                : {}),
          };
        }),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        warnings: extracted.flatMap((e) => e.warnings),
      };
    }
    this.current = { ...this.current, test: results };
    const failed = results.tables.filter((t) => t.error);
    const error = results.error ?? (failed.length > 0 ? failed.map((t) => (results.tables.length > 1 ? `${t.name}: ${t.error}` : t.error)).join('; ') : undefined);
    this.emitter.emit('recorder.testRun', {
      rows: results.tables.reduce((sum, t) => sum + t.rowCount, 0),
      durationMs: results.durationMs,
      ...(error ? { error } : {}),
    });
    return results;
  }

  /** Validate and write the draft through storage. The session stays open. */
  async save(): Promise<HostMessage> {
    const errors = draftErrors(this.draft);
    const validated = validateRecipe(draftToRecipe(this.draft));
    if (errors.length > 0 || !validated.ok) {
      return { kind: 'save.result', ok: false, errors, state: this.current };
    }
    await this.opts.storage.save(validated.recipe);
    this.apply({ type: 'markSaved' });
    const path = this.opts.pathFor?.(validated.recipe.name);
    this.current = {
      ...this.current,
      saved: { name: validated.recipe.name, ...(path ? { path } : {}), at: this.now().toISOString() },
    };
    this.emitter.emit('recorder.saved', { name: validated.recipe.name, ...(path ? { path } : {}) });
    return { kind: 'save.result', ok: true, ...(path ? { path } : {}), errors: [], state: this.current };
  }
}

/**
 * A free variable name from a label, `name`, or `id`: lowercased, other
 * characters as `_`, `fallback` when nothing is left, then `_2`, `_3`, ...
 * while taken.
 */
export function uniqueVarName(draft: Pick<Draft, 'vars'>, hint: string, fallback: string): string {
  let base = hint
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z_]+|_+$/g, '')
    .slice(0, 40);
  if (!base) base = fallback;
  if (!draft.vars.some((v) => v.name === base)) return base;
  for (let n = 2; ; n++) if (!draft.vars.some((v) => v.name === `${base}_${n}`)) return `${base}_${n}`;
}
