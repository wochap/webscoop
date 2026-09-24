import { convertValue, defaultAttr } from '../convert';
import { excludeContainers, extractPage, resolveFirst } from '../extract';
import type { ElementRef, InteractiveSession, PageInfo, StoragePort } from '../ports';
import { scoreFingerprint } from '../healing/score';
import type { FieldScope, FieldType, Fingerprint, SelectorCandidate } from '../recipe/schema';
import { validateRecipe } from '../recipe/validate';
import {
  annotate,
  compoundOf,
  fingerprint,
  generate,
  inferItems,
  nodeAt,
  normalize,
  pathOf,
  rank,
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
  type HostMessage,
  type LevelView,
  type ParsedPageMessage,
  type ParsedSelection,
  type ProposalView,
  type ProtocolCandidate,
  type RecorderState,
  type RepickContext,
  type TestResults,
} from './protocol';

/** `full` records a whole recipe; `repick` focuses on replacing one field's selectors. */
export type RecorderMode =
  | { kind: 'full' }
  | { kind: 'repick'; fieldIndex: number; reason: 'run' | 'cli'; sample?: string | null };

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
type LevelName = 'proposed' | 'broader' | 'narrower';

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
  private proposal: ItemProposal | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: (() => void)[] = [];
  private closedResolve!: (reason: 'closed' | 'ended') => void;
  private readonly closedPromise: Promise<'closed' | 'ended'>;
  private repickResolve!: (outcome: RepickOutcome) => void;
  private readonly repickPromise: Promise<RepickOutcome>;

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
      repick: repickContext ? repickContext.index : null,
      repickContext,
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
    this.dispose();
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
      case 'picker.cancel':
        return;
      case 'picker.select':
        this.current = { ...this.current, url: msg.url };
        return void (await this.select(msg.selection, msg.snapshot as AnnotatedNode));
      case 'inspect.count': {
        const containers = msg.scope === 'item' ? await this.containers() : [];
        const count = msg.scope === 'item' ? await this.countIn(msg.candidate, containers) : await this.countPage(msg.candidate);
        return { kind: 'inspect.countResult', count };
      }
      case 'inspect.primary': {
        const selected = this.current.selected;
        if (!selected || msg.index >= selected.selection.candidates.length) throw new Error('no candidate at that index');
        this.current = { ...this.current, selected: { ...selected, primary: msg.index } };
        return;
      }
      case 'draft.confirmItems':
        return void (await this.confirmItems(msg.level));
      case 'draft.cancelItems':
        this.proposal = null;
        this.current = { ...this.current, proposal: null };
        return;
      case 'draft.setItem':
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
        return void (await this.addField(msg.patch ?? {}));
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
        this.apply({ type: 'removeField', index: msg.index });
        this.emitter.emit('recorder.fieldRemoved', { name: field.name });
        return;
      }
      case 'draft.moveField':
        this.apply({ type: 'moveField', from: msg.from, to: msg.to });
        return;
      case 'draft.repickField':
        this.current = { ...this.current, repick: msg.index };
        return;
      case 'draft.markPagination':
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
    const resolved = await resolveFirst(this.session, item.selectors.map(bare));
    if (!resolved) return [];
    return excludeContainers(this.session, resolved.refs, item.exclude.map(bare));
  }

  private async countPage(candidate: ProtocolCandidate): Promise<number> {
    try {
      return (await this.session.resolve(bare(candidate))).length;
    } catch {
      return 0;
    }
  }

  private async countIn(candidate: ProtocolCandidate, containers: readonly ElementRef[]): Promise<number> {
    let total = 0;
    for (const container of containers) {
      try {
        total += (await this.session.resolve(bare(candidate), container)).length;
      } catch {
        return 0;
      }
    }
    return total;
  }

  private async withCounts<T extends Candidate>(
    candidates: readonly T[],
    scope: FieldScope,
    containers: readonly ElementRef[],
  ): Promise<T[]> {
    const out: T[] = [];
    for (const c of candidates) {
      out.push({ ...c, count: scope === 'item' ? await this.countIn(c, containers) : await this.countPage(c) });
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
      const resolved = await resolveFirst(this.session, item.selectors.map(bare));
      const total = resolved?.refs.length ?? 0;
      containers = resolved ? await excludeContainers(this.session, resolved.refs, item.exclude.map(bare)) : [];
      const exclude: ProtocolCandidate[] = [];
      for (const c of item.exclude) exclude.push({ ...c, count: await this.countPage(c) });
      this.current = {
        ...this.current,
        draft: { ...this.draft, item: { ...this.draft.item!, exclude } },
      };
      this.apply({ type: 'setItemCounts', count: containers.length, total });
    }
    const counts: { count: number | null; sample: string | null }[] = [];
    for (const field of this.draft.fields) {
      const primary = field.selectors[0]!;
      const count = field.scope === 'item' ? await this.countIn(primary, containers) : await this.countPage(primary);
      counts.push({ count, sample: count > 0 ? await this.sample(field, containers) : null });
    }
    this.apply({ type: 'setFieldCounts', counts });
  }

  // Selection ---------------------------------------------------------------

  private async select(selection: ParsedSelection, snapshot: AnnotatedNode): Promise<void> {
    const root = annotate(snapshot);
    const node = nodeAt(root, selection.path);
    if (!node) throw new Error('the selected element is not in the page snapshot');
    this.node = node;

    const base = dedupe(selection.candidates.length > 0 ? selection.candidates : generate(node));
    const containerNode = this.draft.item && selection.containerPath ? nodeAt(root, selection.containerPath) : null;
    let scope: FieldScope = 'page';
    let candidates: ProtocolCandidate[];
    if (containerNode) {
      scope = 'item';
      const containers = await this.containers();
      const compound = compoundOf(containerNode);
      const relative = dedupe(base.map((c) => relativize(c, compound)).filter((c): c is Candidate => c !== null));
      candidates = rank(await this.withCounts(relative, 'item', containers), { itemCount: containers.length });
      if (candidates.length === 0) {
        scope = 'page';
        candidates = rank(await this.withCounts(base, 'page', []));
      }
    } else {
      candidates = rank(await this.withCounts(base, 'page', []));
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
    };
    this.proposal = null;
    this.emitter.emit('recorder.selected', { tag: node.tag, path: selection.path, scope, candidates });

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

    if (!this.draft.item) {
      const proposal = inferItems(node);
      if (proposal) {
        this.proposal = proposal;
        const view = {
          proposed: await this.levelView({ node: proposal.container, items: proposal.siblings }),
          broader: proposal.broader ? await this.levelView(proposal.broader) : null,
          narrower: proposal.narrower ? await this.levelView(proposal.narrower) : null,
          exclude: [],
        };
        this.current = { ...this.current, proposal: view };
        this.emitter.emit('recorder.itemsProposed', {
          count: view.proposed.count,
          container: view.proposed.selectors[0]?.value ?? view.proposed.tag,
          broader: view.broader?.count ?? null,
          narrower: view.narrower?.count ?? null,
        });
      }
    }
  }

  private async levelView(level: ItemLevel): Promise<LevelView> {
    const selectors = rank(await this.withCounts(generate(level.node, { positional: false }), 'page', []), {
      itemCount: level.items.length,
    });
    return {
      tag: level.node.tag,
      label: levelLabel(level.node),
      path: pathOf(level.node),
      selectors,
      count: selectors[0]?.count ?? null,
      total: selectors[0]?.count ?? null,
      paths: level.items.map(pathOf),
      samples: level.items.slice(0, 3).map((n) => excerpt(n)),
    };
  }

  private levelNode(level: LevelName): AnnotatedNode | null {
    const p = this.proposal;
    if (!p) return null;
    if (level === 'proposed') return p.container;
    return (level === 'broader' ? p.broader : p.narrower)?.node ?? null;
  }

  private async confirmItems(level: LevelName): Promise<void> {
    const view = this.current.proposal?.[level];
    const containerNode = this.levelNode(level);
    if (!view || !containerNode) throw new Error(`no ${level} item level to confirm`);
    const selectors = orderForSave(view.selectors, 0);
    const exclude = this.current.proposal?.exclude ?? [];
    this.apply({
      type: 'setItem',
      item: { selectors, exclude, fingerprint: fingerprint(containerNode), count: null, total: null },
    });
    this.proposal = null;
    this.current = { ...this.current, proposal: null };
    await this.recount();
    this.emitter.emit('recorder.itemsConfirmed', { count: this.draft.item!.count, selector: `${selectors[0]!.strategy}=${selectors[0]!.value}` });

    // The original pick becomes an item scoped field.
    const selected = this.current.selected;
    const node = this.node;
    if (!selected || !node || !this.isInside(node, containerNode)) return;
    const containers = await this.containers();
    const relative = dedupe(
      selected.selection.candidates
        .map((c) => relativize(c, compoundOf(containerNode)))
        .filter((c): c is Candidate => c !== null),
    );
    const candidates = rank(await this.withCounts(relative, 'item', containers), { itemCount: containers.length });
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

  private isInside(node: AnnotatedNode, container: AnnotatedNode): boolean {
    for (let cur: AnnotatedNode | null | undefined = node; cur; cur = cur.parent) if (cur === container) return true;
    return false;
  }

  private async setItemFromSelection(): Promise<void> {
    const selected = this.current.selected;
    if (!selected || !this.node) throw new Error('select an element first');
    const selectors = orderForSave(selected.selection.candidates, selected.primary);
    this.apply({ type: 'setItem', item: { selectors, exclude: [], fingerprint: selected.selection.fingerprint, count: null, total: null } });
    this.proposal = null;
    this.current = { ...this.current, proposal: null };
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
    const level = async (view: LevelView | null): Promise<LevelView | null> => {
      const primary = view?.selectors[0];
      if (!view || !primary) return view;
      const refs = await this.session.resolve(bare(primary));
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
          ? { error: `required ${extraction.missingRequired.includes('item') ? 'item container' : `field${extraction.missingRequired.length > 1 ? 's' : ''} ${extraction.missingRequired.join(', ')}`} matched no element` }
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
