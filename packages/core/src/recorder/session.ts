import { convertValue, defaultAttr } from '../convert';
import { containersFor, excludeContainers, extractPage, listParent, resolveFirst } from '../extract';
import type { ElementRef, InteractiveSession, PageInfo, SerializedElement, StoragePort } from '../ports';
import { scoreFingerprint } from '../healing/score';
import type { FieldScope, FieldType, Fingerprint, SelectorCandidate } from '../recipe/schema';
import { validateRecipe } from '../recipe/validate';
import { replaySteps } from '../steps/replay';
import {
  annotate,
  compoundOf,
  descendantsOf,
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
  textContent,
  type AnnotatedNode,
  type Candidate,
  type ItemLevel,
  type ItemProposal,
} from '../selectors';
import { fillTemplate } from '../template';
import {
  bare,
  DEFAULT_PAGINATION,
  detectPagination,
  draftErrors,
  draftToRecipe,
  fieldDefaults,
  reduceDraft,
  type DraftAction,
} from './draft';
import { RecorderEmitter } from './events';
import {
  HOST_BINDING,
  parsePageMessage,
  type Draft,
  type FieldPatch,
  type HostMessage,
  type LevelView,
  type NewStep,
  type ParsedPageMessage,
  type ParsedSelection,
  type ProposalView,
  type ProtocolCandidate,
  type GuardContextView,
  type LevelKind,
  type LevelPick,
  type RecorderState,
  type Rung,
  type RepickContext,
  type TestResults,
} from './protocol';

/**
 * `full` records a whole recipe; `repick` focuses on replacing one field's
 * selectors; `guard` only shows the guard banner while a run waits for a human.
 */
export type RecorderMode =
  | { kind: 'full' }
  | { kind: 'repick'; fieldIndex: number; reason: 'run' | 'cli'; sample?: string | null }
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
}

/** Rows sent to the panel after a test run; the count is always the full count. */
const MAX_TEST_ROWS = 200;
const TOP = new Set(['html', 'body', 'head']);

function excerpt(node: AnnotatedNode, max = 80): string {
  return normalize(textContent(node)).slice(0, max);
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

/** Move the candidate at `index` to the front. */
function toFront<T>(list: readonly T[], index: number): T[] {
  const chosen = list[index];
  if (chosen === undefined) throw new Error(`no candidate at index ${index}`);
  return [chosen, ...list.filter((_, i) => i !== index)];
}

const samePath = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => b[i] === v);
const sameSelector = (a: Candidate, b: Candidate) => a.strategy === b.strategy && a.value === b.value;

/** Primary candidate first, then the rest in ranked order, without candidates that match nothing. */
function orderForSave(candidates: readonly ProtocolCandidate[], primary: number): ProtocolCandidate[] {
  const first = candidates[primary] ?? candidates[0];
  if (!first) return [];
  const rest = candidates.filter((c, i) => i !== primary && c !== first && c.count !== 0);
  return [first, ...rest];
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
  private proposal: ItemProposal | null = null;
  /** Proposal edits that inference does not know about: typed selectors, a cleared list parent, include all. */
  private edits: { within: Candidate | null; item: Candidate | null; withinCleared: boolean; includeAll: boolean } = {
    within: null,
    item: null,
    withinCleared: false,
    includeAll: false,
  };
  /** A typed selection selector waiting for the page to select its first match. */
  private typed: { candidate: ProtocolCandidate; scope: FieldScope } | null = null;
  /** The edited field's saved candidates, counted, waiting for the page to select the field's element. */
  private editSeed: ProtocolCandidate[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: (() => void)[] = [];
  private closedResolve!: (reason: 'closed' | 'ended') => void;
  private readonly closedPromise: Promise<'closed' | 'ended'>;
  private repickResolve!: (outcome: RepickOutcome) => void;
  private readonly repickPromise: Promise<RepickOutcome>;
  private readonly guardListeners = { continue: new Set<() => void>(), abort: new Set<() => void>() };
  /** Set by `detach`: pages that load afterwards are told to remove the recorder. */
  private detached = false;

  constructor(private readonly opts: RecorderOptions) {
    this.emitter = opts.emitter ?? new RecorderEmitter();
    const mode = opts.mode ?? { kind: 'full' };
    let repickContext: RepickContext | null = null;
    if (mode.kind === 'repick') {
      const field = opts.draft.fields[mode.fieldIndex];
      if (!field) throw new Error(`no field at index ${mode.fieldIndex}`);
      repickContext = {
        field: field.name,
        index: mode.fieldIndex,
        oldSelector: bare(field.selectors[0]!),
        fingerprint: field.fingerprint ?? null,
        sample: mode.sample ?? field.sample ?? (field.fingerprint?.textSample || null),
        threshold: opts.draft.healing?.fuzzyThreshold ?? 0.7,
        reason: mode.reason,
        picked: null,
      };
    }
    this.current = {
      url: 'about:blank',
      draft: opts.draft,
      selected: null,
      proposal: null,
      levelPick: null,
      editing: null,
      pendingSelect: null,
      selectorError: null,
      repick: repickContext ? repickContext.index : null,
      repickStep: null,
      repickContext,
      guardContext: null,
      test: null,
      saved: null,
      busy: null,
      error: null,
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

  /** Resolves when the user closes the browser or ends the session from the panel. */
  closed(): Promise<'closed' | 'ended'> {
    return this.closedPromise;
  }

  private get session(): InteractiveSession {
    return this.opts.session;
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
    const info = await this.session.goto(this.targetUrl(), { timeoutMs: this.opts.timeoutMs ?? 30_000 });
    this.current = { ...this.current, url: info.url };
    return info;
  }

  /**
   * Expose the bridge and inject the bundle into the page already open, without
   * navigating. The page announces itself with `session.ready` and gets the state.
   */
  async attach(): Promise<void> {
    await this.session.expose(HOST_BINDING, (msg) => this.handle(msg));
    await this.session.inject(this.opts.bundle);
    this.unsubscribe.push(
      this.session.onNavigated((url) => {
        this.current = { ...this.current, url };
        this.emitter.emit('recorder.navigated', { url });
      }),
      this.session.onClosed(() => {
        this.repickResolve({ kind: 'abort' });
        if (this.current.guardContext) this.fireGuard('abort');
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

  /** Entry point for the page binding. Messages are handled one at a time, in order. */
  handle(raw: unknown): Promise<HostMessage> {
    const run = this.queue.then(() => this.process(raw));
    this.queue = run.catch(() => {});
    return run;
  }

  private async process(raw: unknown): Promise<HostMessage> {
    try {
      const msg = parsePageMessage(raw);
      const reply = await this.route(msg);
      if (this.current.error) this.current = { ...this.current, error: null };
      return reply ?? this.stateMessage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.current = { ...this.current, error: message, busy: null };
      this.emitter.emit('recorder.error', { message });
      return this.stateMessage();
    }
  }

  private stateMessage(): HostMessage {
    return { kind: 'draft.state', state: this.current };
  }

  /** Send the current state to the page without waiting for a page request. */
  async push(): Promise<void> {
    try {
      await this.session.dispatch(this.stateMessage());
    } catch {
      // The page is navigating; it asks for the state again once it is ready.
    }
  }

  private apply(action: DraftAction): void {
    this.current = { ...this.current, draft: reduceDraft(this.current.draft, action) };
  }

  private async route(msg: ParsedPageMessage): Promise<HostMessage | void> {
    switch (msg.kind) {
      case 'session.ready':
        // A page loaded after the host detached still runs the injected bundle; tell it to go away.
        if (this.detached) return { kind: 'session.detach' };
        this.current = { ...this.current, url: msg.url };
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
      case 'inspect.count': {
        const containers = msg.scope === 'item' ? await this.containers() : [];
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
        return void (await this.confirmItems(msg.level));
      case 'draft.cancelItems':
        this.dropProposal();
        return;
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
        return void (await this.setPrimary(msg.level, msg.index, msg.rung ?? 'proposed'));
      case 'draft.setItem':
        this.notEditing();
        return void (await this.setItemFromSelection());
      case 'draft.clearItem':
        this.apply({ type: 'setItem', item: null });
        await this.recount();
        return;
      case 'draft.addExclusion':
        return void (await this.addExclusion(msg.selector));
      case 'draft.removeExclusion':
        return void (await this.removeExclusion(msg.index));
      case 'draft.addField':
        this.notEditing();
        return void (await this.addField(msg.patch ?? {}));
      case 'draft.editField':
        return void (await this.editField(msg.index, msg.snapshot));
      case 'draft.updateEditedField':
        return void (await this.updateEditedField(msg.patch));
      case 'draft.cancelEdit':
        if (!this.current.editing) throw new Error('no field is being edited');
        this.clearSelection();
        return;
      case 'draft.updateField': {
        const before = this.draft.fields[msg.index];
        if (!before) throw new Error(`no field at index ${msg.index}`);
        this.apply({ type: 'updateField', index: msg.index, patch: msg.patch });
        if (msg.patch.type !== undefined || msg.patch.attr !== undefined || msg.patch.scope !== undefined) await this.recount();
        return;
      }
      case 'draft.removeField': {
        const field = this.draft.fields[msg.index];
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
        this.current =
          msg.target === 'field' ? { ...this.current, repick: msg.index, repickStep: null } : { ...this.current, repickStep: msg.index, repick: null };
        return;
      case 'draft.addStep':
        if (msg.selection === undefined) this.notEditing();
        return void (await this.addStep(msg.step, msg.selection));
      case 'draft.updateStep':
        if (!this.draft.steps[msg.index]) throw new Error(`no step at index ${msg.index}`);
        this.apply({ type: 'updateStep', index: msg.index, patch: msg.patch });
        return;
      case 'draft.removeStep':
        if (!this.draft.steps[msg.index]) throw new Error(`no step at index ${msg.index}`);
        this.apply({ type: 'removeStep', index: msg.index });
        return;
      case 'draft.moveStep':
        this.apply({ type: 'moveStep', from: msg.from, to: msg.to });
        return;
      case 'draft.replayStep':
        return this.replayStep(msg.index);
      case 'draft.markPagination':
        this.notEditing();
        return void this.markPagination();
      case 'draft.updatePagination':
        this.apply({ type: 'updatePagination', patch: msg.patch });
        this.emitter.emit('recorder.paginationSet', { kind: this.draft.pagination!.kind });
        return;
      case 'draft.clearPagination':
        this.apply({ type: 'setPagination', pagination: null });
        return;
      case 'draft.setName':
        this.apply({ type: 'setName', name: msg.name });
        return;
      case 'draft.setVar':
        this.apply({ type: 'setVar', name: msg.name, value: msg.value });
        return;
      case 'draft.reopen':
        // Navigating tears down the page that sent this message; do not wait for it.
        void this.handleInternal(() => this.session.goto(this.targetUrl(), { timeoutMs: this.opts.timeoutMs ?? 30_000 }));
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
    const field = this.draft.fields[ctx.index]!;
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
    const run = this.queue.then(work).then(
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

  private async containers(): Promise<ElementRef[]> {
    const item = this.draft.item;
    if (!item) return [];
    const parent = await listParent(this.session, item.within?.map(bare));
    if (parent === null) return [];
    return containersFor(this.session, item.selectors.map(bare), item.exclude.map(bare), parent);
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

  /** Refresh item and field counts on the current page. */
  async recount(): Promise<void> {
    const item = this.draft.item;
    let containers: ElementRef[] = [];
    if (item) {
      const parent = await listParent(this.session, item.within?.map(bare));
      const resolved = parent === null ? null : await resolveFirst(this.session, item.selectors.map(bare), parent);
      const total = resolved?.refs.length ?? 0;
      containers = resolved ? await excludeContainers(this.session, resolved.refs, item.exclude.map(bare)) : [];
      const exclude: ProtocolCandidate[] = [];
      for (const c of item.exclude) exclude.push({ ...c, count: await this.countPage(c) });
      this.current = {
        ...this.current,
        draft: { ...this.draft, item: { ...this.draft.item!, exclude } },
      };
      const withinCount = item.within?.[0] ? await this.countPage(item.within[0]) : null;
      this.apply({ type: 'setItemCounts', count: containers.length, total, withinCount });
    }
    const counts: { count: number | null; sample: string | null }[] = [];
    for (const field of this.draft.fields) {
      const primary = field.selectors[0]!;
      const count = field.scope === 'item' ? (await this.countIn(primary, containers)).count : await this.countPage(primary);
      counts.push({ count, sample: count > 0 ? await this.sample(field, containers) : null });
    }
    this.apply({ type: 'setFieldCounts', counts });
    const stepCounts: (number | null)[] = [];
    for (const step of this.draft.steps) stepCounts.push(step.target ? await this.countPage(step.target.selectors[0]!) : null);
    this.apply({ type: 'setStepCounts', counts: stepCounts });
  }

  // Selection ---------------------------------------------------------------

  private async select(selection: ParsedSelection, snapshot: AnnotatedNode): Promise<void> {
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

    const base = dedupe(selection.candidates.length > 0 ? selection.candidates : generate(node));
    const containerNode = this.draft.item && selection.containerPath ? nodeAt(root, selection.containerPath) : null;
    let scope: FieldScope = 'page';
    let candidates: ProtocolCandidate[];
    if (containerNode) {
      scope = 'item';
      const containers = await this.containers();
      const relative = this.relativeTo(node, containerNode, base);
      candidates = rank(await this.withCounts(relative, 'item', containers, true), { itemCount: containers.length });
      if (candidates.length === 0) {
        scope = 'page';
        candidates = rank(await this.withCounts(base, 'page', []));
      }
    } else {
      candidates = rank(await this.withCounts(base, 'page', []));
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

    const taken = this.draft.fields.map((f) => f.name);
    const defaults = fieldDefaults(
      { tag: node.tag, attrs: node.attrs, text: selection.text, ...(selection.role ? { role: selection.role } : {}), ...(selection.name ? { name: selection.name } : {}) },
      taken,
    );
    this.current = {
      ...this.current,
      selected: { selection: { ...selection, candidates }, scope, defaults, primary: 0 },
      proposal: null,
      levelPick: null,
      pendingSelect: null,
      selectorError: null,
    };
    this.proposal = null;
    this.resetEdits();
    this.emitter.emit('recorder.selected', { tag: node.tag, path: selection.path, scope, candidates });
    // An edited field takes the new selection when updated; no step, re-pick, or item inference.
    if (editing) return;

    const repickStep = this.current.repickStep;
    if (repickStep !== null && this.draft.steps[repickStep]) {
      const selectors = orderForSave(rank(await this.withCounts(generate(node), 'page', [])), 0);
      this.apply({ type: 'replaceStepTarget', index: repickStep, selectors, fingerprint: selection.fingerprint, count: selectors[0]?.count ?? null });
      this.current = { ...this.current, repickStep: null };
      return;
    }

    const repick = this.current.repick;
    if (repick !== null && this.draft.fields[repick]) {
      const field = this.draft.fields[repick]!;
      const containers = scope === 'item' ? await this.containers() : [];
      const selectors = orderForSave(candidates, 0);
      const sample = await this.sample({ ...field, scope, selectors }, containers);
      this.apply({ type: 'replaceSelectors', index: repick, selectors, fingerprint: selection.fingerprint, count: selectors[0]?.count ?? null, sample });
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

    if (!this.draft.item && !typed) {
      const proposal = inferItems(node);
      if (proposal) {
        this.proposal = proposal;
        await this.showProposal();
        const view = this.current.proposal!;
        this.emitter.emit('recorder.itemsProposed', {
          count: view.proposed.count,
          container: view.proposed.selectors[0]?.value ?? view.proposed.tag,
          within: view.within?.selectors[0]?.value ?? null,
          skipped: view.skipped,
          broader: view.broader?.count ?? null,
          narrower: view.narrower?.count ?? null,
        });
      }
    }
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

  private resetEdits(): void {
    this.edits = { within: null, item: null, withinCleared: false, includeAll: false };
  }

  private dropProposal(): void {
    this.proposal = null;
    this.resetEdits();
    this.current = { ...this.current, proposal: null, levelPick: null };
  }

  /** Back to the empty state: no selection, proposal, typed selector, or field edit. The draft does not change. */
  private clearSelection(): void {
    this.node = null;
    this.root = null;
    this.typed = null;
    this.editSeed = null;
    this.dropProposal();
    this.current = { ...this.current, selected: null, editing: null, pendingSelect: null, selectorError: null };
  }

  private notEditing(): void {
    if (this.current.editing) throw new Error('finish editing the field first: update or cancel it');
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
    const scope: FieldScope = scopeHint ?? this.current.editing?.options.scope ?? this.current.selected?.scope ?? (this.draft.item ? 'item' : 'page');
    const candidate = parseSelector(text);
    const containers = scope === 'item' ? await this.containers() : [];
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
    const field = this.draft.fields[index];
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
    const field = this.draft.fields[editing.index];
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
        ...(fp ? { fingerprint: fp } : {}),
        count,
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
    const proposed = await this.levelView({ node: p.container, items }, parent, this.edits.item);
    // A broader level at the list parent itself has no form relative to it.
    const broader = p.broader && (!withinNode || (p.broader.node !== withinNode && isInside(p.broader.node, withinNode))) ? await this.levelView(p.broader, parent) : null;
    const narrower = p.narrower ? await this.levelView(p.narrower, parent) : null;
    const fellBack = [proposed, broader, narrower].some((l) => l?.fellBack);
    let view: ProposalView = {
      within: withinNode ? await this.withinView(withinNode, this.edits.within) : null,
      proposed: proposed.view,
      broader: broader?.view ?? null,
      narrower: narrower?.view ?? null,
      skipped: this.edits.includeAll ? 0 : p.skipped.length,
      includeAll: this.edits.includeAll,
      error:
        error ??
        (fellBack
          ? { level: 'item', message: 'no item container selector matches inside the list parent; showing selectors for the whole page' }
          : null),
      exclude: previous?.exclude ?? [],
    };
    if (view.exclude.length > 0) view = await this.recountProposal(view);
    this.current = { ...this.current, proposal: view };
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
    itemCount: number,
  ): Promise<{ selectors: Candidate[]; fellBack: boolean }> {
    const generated = generate(node, { positional: false, level: true });
    if (!parent) return { selectors: rank(await this.countWithin(generated, undefined), { itemCount }), fellBack: false };
    const relative = dedupe(generated.map((c) => relativize(c, parent.node)).filter((c): c is Candidate => c !== null));
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
      samples: level.items.slice(0, 3).map((n) => excerpt(n)),
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

  private levelNode(level: Rung): AnnotatedNode | null {
    const p = this.proposal;
    if (!p) return null;
    if (level === 'proposed') return p.container;
    return (level === 'broader' ? p.broader : p.narrower)?.node ?? null;
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
      if (level === 'within') return { level, ancestorOf: [view.proposed.path], ofContainers: false, descendantOf: null, containing: null };
      const within = this.proposalWithin();
      return { level, ancestorOf: [], ofContainers: false, descendantOf: within ? pathOf(within) : null, containing: this.node ? pathOf(this.node) : null };
    }
    if (this.draft.item && level === 'within') return { level, ancestorOf: [], ofContainers: true, descendantOf: null, containing: null };
    throw new Error(level === 'within' ? 'set an item container before its list parent' : 'no item proposal to change');
  }

  private async setLevel(
    level: LevelKind,
    by: 'pick' | 'selector' | 'clear',
    msg: { path?: number[] | undefined; selector?: string | undefined; snapshot?: SerializedElement | undefined },
  ): Promise<void> {
    this.current = { ...this.current, levelPick: null };
    if (this.proposal && this.current.proposal) return this.editProposal(level, by, msg);
    if (this.draft.item && level === 'within') return this.editItemWithin(by, msg);
    throw new Error(level === 'within' ? 'set an item container before its list parent' : 'no item proposal to change');
  }

  /** Edit a proposal field; a refused edit shows its reason and keeps the previous value. */
  private async editProposal(
    level: LevelKind,
    by: 'pick' | 'selector' | 'clear',
    msg: { path?: number[] | undefined; selector?: string | undefined },
  ): Promise<void> {
    const p = this.proposal!;
    const pick = this.node!;
    const root = this.root!;
    const refuse = (message: string) => {
      this.current = { ...this.current, proposal: { ...this.current.proposal!, error: { level, message } } };
    };
    if (by === 'clear') {
      if (level === 'item') return refuse('the item container cannot be empty; choose "Not a list" instead');
      this.edits = { ...this.edits, within: null, withinCleared: true };
      return this.showProposal();
    }
    if (by === 'pick') {
      const node = msg.path ? nodeAt(root, msg.path) : null;
      if (!node) return refuse('the picked element is not in the page snapshot');
      if (level === 'within') {
        if (TOP.has(node.tag) || node === p.container || !isInside(p.container, node)) return refuse('outside the list: pick an element that holds the item');
        const next = inferItems(pick, { within: node });
        if (!next) return refuse('no items like the picked one inside that element');
        this.proposal = next;
        this.edits = { ...this.edits, within: null, item: null, withinCleared: false };
        return this.showProposal();
      }
      const within = this.proposalWithin();
      const listRoot = within ?? root.children.find((c): c is AnnotatedNode => c.type === 'element' && c.tag === 'body') ?? root;
      if (TOP.has(node.tag) || node === listRoot || !isInside(node, listRoot)) return refuse('outside the list: pick an element inside the list parent');
      if (!isInside(pick, node)) return refuse('pick an element that holds the selected element');
      const next = inferItems(pick, { within: listRoot, item: node });
      if (!next) return refuse('no items at that level');
      this.proposal = { ...next, within: p.within };
      this.edits = { ...this.edits, item: null };
      return this.showProposal();
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
    if (refs.length === 0) return refuse(`"${text}" matches nothing${withinRef ? ' inside the list parent' : ''}`);
    if (level === 'within') {
      const [node] = await this.nodesFor([refs[0]!], root);
      if (!node) return refuse(`"${text}" matches an element that is not in the page snapshot`);
      if (!isInside(pick, node) || node === pick) return refuse('outside the list: the list parent must hold the selected element');
      const next = inferItems(pick, { within: node });
      if (!next) return refuse(`no items like the picked one inside "${text}"`);
      this.proposal = next;
      this.edits = { ...this.edits, within: candidate, item: null, withinCleared: false };
      return this.showProposal();
    }
    const nodes = await this.nodesFor(refs, within ?? root);
    const container = nodes.find((n) => isInside(pick, n)) ?? nodes[0];
    if (!container) return refuse(`"${text}" matches elements that are not in the page snapshot`);
    this.proposal = { ...p, container, siblings: nodes, all: nodes, skipped: [], broader: null, narrower: null };
    this.edits = { ...this.edits, item: candidate };
    return this.showProposal();
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
    const { count: _c, total: _t, ...rest } = this.draft.item!;
    this.apply({ type: 'setItem', item: { ...rest, selectors, count: null, total: null } });
  }

  /**
   * Item container selectors for a new list parent (or the document, for
   * null): regenerated for the first current container inside it, relative to
   * it, and counted there. The old primary selector stays first when its
   * relative form still finds that container.
   */
  private async rewriteItem(root: AnnotatedNode, parent: { node: AnnotatedNode; ref: ElementRef } | null): Promise<ProtocolCandidate[]> {
    const item = this.draft.item!;
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
    const relative = parent ? relativize(old, parent.node) : bare(old);
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

  private async setPrimary(level: LevelKind, index: number, rung: Rung): Promise<void> {
    const view = this.current.proposal;
    if (view && this.proposal) {
      const target = level === 'within' ? view.within : view[rung];
      if (!target || !target.selectors[index]) throw new Error(`no candidate at index ${index}`);
      const updated = { ...target, primary: index, count: target.selectors[index].count ?? null, total: target.selectors[index].count ?? null };
      this.current = { ...this.current, proposal: level === 'within' ? { ...view, within: updated } : { ...view, [rung]: updated } };
      if (view.exclude.length > 0) this.current = { ...this.current, proposal: await this.recountProposal(this.current.proposal!) };
      return;
    }
    const item = this.draft.item;
    if (!item) throw new Error('no item container to change');
    if (level === 'within') {
      if (!item.within) throw new Error('the item container has no list parent');
      this.apply({ type: 'setWithin', within: toFront(item.within, index), ...(item.withinFingerprint ? { fingerprint: item.withinFingerprint } : {}) });
    } else {
      const { count: _c, total: _t, ...rest } = item;
      this.apply({ type: 'setItem', item: { ...rest, selectors: toFront(item.selectors, index), count: null, total: null } });
    }
    await this.recount();
  }

  private async confirmItems(level: Rung): Promise<void> {
    const proposal = this.current.proposal;
    const view = proposal?.[level];
    const containerNode = this.levelNode(level);
    if (!proposal || !view || !containerNode) throw new Error(`no ${level} item level to confirm`);
    const selectors = orderForSave(view.selectors, view.primary);
    const exclude = proposal.exclude;
    const withinNode = this.proposalWithin();
    const within = proposal.within && withinNode ? orderForSave(proposal.within.selectors, proposal.within.primary) : [];
    this.apply({
      type: 'setItem',
      item: {
        selectors,
        ...(within.length > 0 ? { within, withinFingerprint: fingerprint(withinNode!), withinCount: null } : {}),
        exclude,
        fingerprint: fingerprint(containerNode),
        count: null,
        total: null,
      },
    });
    this.dropProposal();
    await this.recount();
    this.emitter.emit('recorder.itemsConfirmed', { count: this.draft.item!.count, selector: `${selectors[0]!.strategy}=${selectors[0]!.value}` });

    // The original pick becomes an item scoped field.
    const selected = this.current.selected;
    const node = this.node;
    if (!selected || !node || !isInside(node, containerNode) || node === containerNode) return;
    const containers = await this.containers();
    const relative = this.relativeTo(node, containerNode, selected.selection.candidates);
    const candidates = rank(await this.withCounts(relative, 'item', containers, true), { itemCount: containers.length });
    if (candidates.length === 0) return;
    this.current = {
      ...this.current,
      selected: {
        ...selected,
        scope: 'item',
        primary: 0,
        selection: { ...selected.selection, candidates, containerPath: pathOf(containerNode) },
      },
    };
    await this.addField({});
  }

  private async setItemFromSelection(): Promise<void> {
    const selected = this.current.selected;
    if (!selected || !this.node) throw new Error('select an element first');
    const selectors = orderForSave(selected.selection.candidates, selected.primary);
    this.apply({ type: 'setItem', item: { selectors, exclude: [], fingerprint: selected.selection.fingerprint, count: null, total: null } });
    this.dropProposal();
    await this.recount();
    this.emitter.emit('recorder.itemsConfirmed', { count: this.draft.item!.count, selector: `${selectors[0]!.strategy}=${selectors[0]!.value}` });
  }

  private async addExclusion(selector: string): Promise<void> {
    const proposal = this.current.proposal;
    if (!this.draft.item && !proposal) throw new Error('find or set an item container before adding an exclusion');
    const candidate: ProtocolCandidate = { strategy: 'css', value: selector.trim(), stability: 'medium' };
    let matches: number;
    try {
      matches = (await this.session.resolve(candidate)).length;
    } catch (error) {
      throw new Error(`invalid exclusion selector "${selector}": ${(error as Error).message.split('\n')[0]}`, { cause: error });
    }
    if (this.draft.item) {
      this.apply({ type: 'addExclusion', candidate });
      await this.recount();
      this.emitter.emit('recorder.excluded', { selector: candidate.value, count: this.draft.item!.count });
      return;
    }
    const exclude = [...proposal!.exclude, { ...candidate, count: matches }];
    this.current = { ...this.current, proposal: await this.recountProposal({ ...proposal!, exclude }) };
    this.emitter.emit('recorder.excluded', { selector: candidate.value, count: this.current.proposal!.proposed.count });
  }

  private async removeExclusion(index: number): Promise<void> {
    const proposal = this.current.proposal;
    if (this.draft.item || !proposal) {
      this.apply({ type: 'removeExclusion', index });
      await this.recount();
      return;
    }
    this.current = {
      ...this.current,
      proposal: await this.recountProposal({ ...proposal, exclude: proposal.exclude.filter((_, i) => i !== index) }),
    };
  }

  /** Recount each proposal level with the pending exclusions applied. */
  private async recountProposal(proposal: ProposalView): Promise<ProposalView> {
    const exclude = proposal.exclude.map(bare);
    const withinRef = await this.refOf(this.proposalWithin());
    const level = async (view: LevelView | null): Promise<LevelView | null> => {
      const primary = view?.selectors[view.primary];
      if (!view || !primary) return view;
      const refs = await this.session.resolve(bare(primary), withinRef);
      const kept = await excludeContainers(this.session, refs, exclude);
      return { ...view, count: kept.length, total: refs.length };
    };
    return {
      ...proposal,
      proposed: (await level(proposal.proposed))!,
      broader: await level(proposal.broader),
      narrower: await level(proposal.narrower),
    };
  }

  private async addField(patch: {
    name?: string;
    type?: FieldType;
    scope?: FieldScope;
    attr?: string | null;
    optional?: boolean;
    key?: boolean;
  }): Promise<void> {
    const selected = this.current.selected;
    if (!selected) throw new Error('select an element first');
    const selectors = orderForSave(selected.selection.candidates, selected.primary);
    if (selectors.length === 0) throw new Error('the selection has no selector candidates');
    const type = patch.type ?? selected.defaults.type;
    const attr = patch.attr === null ? undefined : (patch.attr ?? (patch.type && patch.type !== selected.defaults.type ? defaultAttr(type) : selected.defaults.attr));
    const scope = patch.scope ?? selected.scope;
    const taken = this.draft.fields.map((f) => f.name);
    const name = patch.name ?? (taken.includes(selected.defaults.name) ? fieldDefaults({ tag: selected.selection.tag, attrs: selected.selection.attrs, text: selected.selection.text, ...(selected.selection.name ? { name: selected.selection.name } : {}) }, taken).name : selected.defaults.name);
    const containers = scope === 'item' ? await this.containers() : [];
    const sample = await this.sample({ selectors, type, scope, ...(attr ? { attr } : {}) }, containers);
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
        fingerprint: selected.selection.fingerprint,
        count: selectors[0]!.count ?? null,
        sample,
      },
    });
    this.emitter.emit('recorder.fieldAdded', { name, type, scope, count: selectors[0]!.count ?? null });
    this.clearSelection();
  }

  /**
   * Add a step. With a selection (browse mode) its candidates are the target;
   * without one (`undefined`) the picked element is; `null` means no target,
   * such as a key press on whatever has focus.
   */
  private async addStep(step: NewStep, selection: ParsedSelection | null | undefined): Promise<void> {
    let target: { selectors: ProtocolCandidate[]; fingerprint: ParsedSelection['fingerprint'] } | undefined;
    if (selection) {
      target = { selectors: orderForSave(rank(dedupe(selection.candidates)), 0), fingerprint: selection.fingerprint };
    } else if (selection === undefined) {
      const selected = this.current.selected;
      if (!selected || !this.node) throw new Error('select an element first');
      // The pick may be item scoped; a step target is always found in the whole document.
      target = { selectors: orderForSave(rank(await this.withCounts(generate(this.node), 'page', [])), 0), fingerprint: selected.selection.fingerprint };
    }
    if (target && target.selectors.length === 0) throw new Error('the element has no selector candidates');
    this.apply({
      type: 'addStep',
      step: {
        kind: step.kind,
        ...(target ? { target } : {}),
        ...(step.value !== undefined ? { value: step.value } : {}),
        ...(step.when ? { when: step.when } : {}),
        ...(step.optional !== undefined ? { optional: step.optional } : {}),
        count: target?.selectors[0]?.count ?? null,
      },
    });
    const primary = target?.selectors[0];
    this.emitter.emit('recorder.stepAdded', {
      index: this.draft.steps.length - 1,
      kind: step.kind,
      target: primary ? `${primary.strategy}=${primary.value}` : null,
      ...(step.value !== undefined ? { value: step.value } : {}),
    });
  }

  /** Run one step on the live page, the way a run would, and report how it went. */
  private async replayStep(index: number): Promise<HostMessage> {
    const step = this.draft.steps[index];
    if (!step) throw new Error(`no step at index ${index}`);
    const validated = validateRecipe(draftToRecipe(this.draft));
    let ok = false;
    let message: string;
    if (!validated.ok) {
      message = validated.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    } else {
      const recipe = { ...validated.recipe, steps: [validated.recipe.steps[index]!] };
      const values = Object.fromEntries(this.draft.vars.filter((v) => v.value !== '').map((v) => [v.name, v.value]));
      try {
        const result = await replaySteps(this.session, recipe, { page: 1, vars: values, timeoutMs: this.opts.timeoutMs ?? 30_000, cache: new Map() });
        const report = result.steps[0];
        ok = report?.outcome === 'ok' || report?.outcome === 'healed';
        message = ok ? `replayed step ${index + 1} (${step.kind})` : `skipped step ${index + 1}: ${report?.notes?.join('; ') ?? 'found no element'}`;
      } catch (error) {
        message = `step ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.emitter.emit('recorder.stepReplayed', { index, kind: step.kind, ok, message });
    return { kind: 'step.replayResult', index, ok, message, state: this.current };
  }

  private markPagination(): void {
    const selected = this.current.selected;
    if (!selected) throw new Error('select the pagination control first');
    const { selection } = selected;
    const detected = detectPagination(
      { tag: selection.tag, attrs: selection.attrs, ...(selection.role ? { role: selection.role } : {}) },
      this.current.url,
    );
    const previous = this.draft.pagination ?? DEFAULT_PAGINATION;
    const { param: _param, ...rest } = previous;
    this.apply({
      type: 'setPagination',
      pagination: {
        ...rest,
        kind: detected.kind,
        ...(detected.param ? { param: detected.param } : {}),
        target: { selectors: orderForSave(selection.candidates, selected.primary), fingerprint: selection.fingerprint },
      },
    });
    this.emitter.emit('recorder.paginationSet', { kind: detected.kind });
  }

  // Test run and save --------------------------------------------------------

  /** Run the draft on the current page, page 1 only, with the runner's extraction. */
  async testRun(): Promise<TestResults> {
    const started = this.now();
    const validated = validateRecipe(draftToRecipe(this.draft));
    let results: TestResults;
    if (!validated.ok) {
      results = {
        rows: [],
        rowCount: 0,
        fields: [],
        durationMs: 0,
        warnings: [],
        error: validated.errors.map((e) => `${e.path}: ${e.message}`).join('\n'),
      };
    } else {
      const extraction = await extractPage(this.session, validated.recipe, { pageUrl: this.current.url, page: 1 });
      results = {
        rows: extraction.rows.slice(0, MAX_TEST_ROWS),
        rowCount: extraction.rows.length,
        fields: extraction.fields.map((f) => ({ name: f.name, status: f.status })),
        durationMs: Math.max(0, this.now().getTime() - started.getTime()),
        warnings: extraction.warnings,
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
          : {}),
      };
    }
    this.current = { ...this.current, test: results };
    this.emitter.emit('recorder.testRun', {
      rows: results.rowCount,
      durationMs: results.durationMs,
      ...(results.error ? { error: results.error } : {}),
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
