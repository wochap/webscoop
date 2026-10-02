import type { AttentionOutcome, FlowKind, PageReport, Row, RunEmitter, RunEvents, RunReport } from '../events';
import { countItems, extractTable, resolvePaginationTarget, type ResolvedSelectors, type TableExtraction } from '../extract';
import { RunFailure } from '../failure';
import { awaitUserLabel, runFlow, type AwaitUserRequest, type StepCache } from '../flows/replay';
import { targetPresent, type RunWindows } from '../flows/windows';
import type { AttentionLease } from '../guards/attention';
import type { AttentionKind, GuardBannerHandler, GuardBannerHooks } from '../guards/banner';
import { GuardBudget } from '../guards/budget';
import { detect, guardContext, LOGIN_URL_PATTERN, type GuardDetector, type GuardMatch } from '../guards/detectors';
import { Recheck, waitForClear, type WaitResult } from '../guards/wait';
import { defaultLadder } from '../healing/ladder';
import type { Promotion } from '../healing/promote';
import { isHealed, type Resolver } from '../healing/types';
import { NoopNotify, type NotifyPort, type PageInfo, type Session } from '../ports';
import { Dedup, evaluateStop, type PageSummary } from '../pagination/dedup';
import type { PagerContext, PageStrategy, StopReason } from '../pagination/types';
import type { Block, Flow, InnerBlock, Paginate, Recipe, RecipeTable, SelectorCandidate } from '../recipe/schema';
import { drivingTable, isReactive, maxRetriesOf } from '../recipe/sequence';
import { primaryTableIndex, tablesOf } from '../recipe/tables';

/** What the interpreter needs from the runner that owns the run. */
export interface SequenceHost {
  recipe: Recipe;
  emitter: RunEmitter;
  report: RunReport;
  /** Every row emitted so far, in order. */
  rows: Row[];
  windows: RunWindows;
  strategy: PageStrategy;
  vars?: Readonly<Record<string, string>>;
  timeoutMs: number;
  limit: number | 'all';
  cap: number;
  delayMs: number;
  /** False runs no flow, called or reactive. */
  flowsEnabled: boolean;
  detectors: GuardDetector[];
  budget: GuardBudget;
  banner?: GuardBannerHandler;
  notify?: NotifyPort;
  pollMs?: number;
  signal?: AbortSignal;
  healing: { enabled: boolean; resolvers: Resolver[] };
  /** The re-pick rung for required fields, for the given page, when a human is available. */
  repick?: (page: number) => Resolver;
  onHealed(page: number): (promotion: Promotion) => void;
  transition(to: RunStateName): void;
  state(): RunStateName;
  acquireAttention(): Promise<AttentionLease>;
  needAttention(payload: RunEvents['attention.needed']): void;
  resolveAttention(outcome: AttentionOutcome): void;
  sleep(ms: number): Promise<void>;
}

export type RunStateName = 'idle' | 'opening' | 'navigating' | 'stepping' | 'extracting' | 'guarded' | 'repicking' | 'paginating' | 'done' | 'failed';

/** One table's state across the run. */
interface TableState {
  table: RecipeTable;
  /** Selectors the table settled on: undefined before its first extraction, null while it still has to be resolved. */
  resolved: ResolvedSelectors | null | undefined;
  /** Item tables only: rows seen on earlier pages. */
  dedup: Dedup | null;
}

/** One extraction: the table as found, and its rows after dedup, not yet emitted. */
interface Extracted {
  found: TableExtraction;
  fresh: { kept: Row[]; dropped: number; commit(): void };
}

/** The part of the sequence that ran since the last navigation the runner made itself, for recovery. */
interface Batch {
  url: string;
  /** Called flows of the batch that completed, in order. */
  flowsRun: string[];
}

/**
 * Runs a recipe's sequence on an open window: called flows, extractions, and
 * the paginate block's page loop, with guards, reactive flows at every
 * checkpoint, and recovery of the page state after an interruption.
 */
export class SequenceRun {
  private readonly tables: TableState[];
  private readonly multi: boolean;
  /** The table the report's top level `item` and `fields` mirror: the driving table, else the first item table, else the first. */
  private readonly mirror: string | undefined;
  /** The table whose absence on its first extraction fails the run; other lists may be absent. */
  private readonly lead: string | null;
  private readonly flows: Map<string, Flow>;
  private readonly reactive: Flow[];
  private readonly retries = new Map<string, number>();
  private readonly cache: StepCache = new Map();
  private page = 1;
  private info!: PageInfo;
  private batch: Batch;
  /** The paginate block running now, for recovery. */
  private paginating: Paginate | null = null;
  /** A reactive flow is running: no trigger fires until it ends. */
  private reacting = false;
  private targetSelectors: { selectors: SelectorCandidate[]; frame?: SelectorCandidate[] } | null = null;

  constructor(private readonly host: SequenceHost) {
    const { recipe } = host;
    const tables = tablesOf(recipe);
    this.tables = tables.map((table) => ({ table, resolved: undefined, dedup: table.item ? new Dedup(table) : null }));
    this.multi = tables.length > 1;
    const paginate = recipe.sequence.find((b): b is Extract<Block, { paginate: Paginate }> => 'paginate' in b)?.paginate;
    const driving = paginate ? drivingTable(paginate, tables) : null;
    const primary = primaryTableIndex(tables);
    this.lead = driving ?? (primary >= 0 ? tables[primary]!.name : null);
    this.mirror = this.lead ?? tables[0]?.name;
    this.flows = new Map(recipe.flows.map((f) => [f.name, f]));
    this.reactive = recipe.flows.filter(isReactive);
    this.batch = { url: host.strategy.url, flowsRun: [] };
  }

  /** Navigate to the first page, check its guards, then run every block of the sequence. Returns why the page loop ended. */
  async run(): Promise<StopReason> {
    const { host } = this;
    host.transition('navigating');
    this.info = await host.strategy.first(this.pager());
    this.batch = { url: host.strategy.url, flowsRun: [] };
    await this.loaded(this.info);

    let reason: StopReason = 'none';
    for (const block of host.recipe.sequence) {
      if ('paginate' in block) reason = await this.paginate(block.paginate);
      else await this.inner(block, null);
    }
    if (!host.recipe.sequence.some((b) => 'paginate' in b)) {
      const entry = host.report.pages.find((p) => p.page === this.page);
      if (entry) host.emitter.emit('page.done', { page: this.page, rows: entry.rows });
      // Without pagination the run is one page, with rows or not.
      host.report.pageCount = 1;
    }
    return reason;
  }

  /** Report a settled main window page, check its load guards, then let reactive flows look at it. */
  private async loaded(info: PageInfo): Promise<void> {
    const { host } = this;
    this.info = info;
    host.report.finalUrl = info.url;
    host.emitter.emit('page.loaded', { page: this.page, url: info.url, title: info.title, status: info.status });
    await this.guardLoad();
    await this.checkpoint();
  }

  /** A flow or extract block, outside or inside the paginate block. */
  private async inner(block: InnerBlock, driving: { name: string | null; fromIndex?: number } | null): Promise<Extracted | null> {
    if ('flow' in block) {
      await this.calledFlow(block.flow);
      return null;
    }
    const fromIndex = driving && driving.name === block.extract ? driving.fromIndex : undefined;
    const extracted = await this.extract(block.extract, fromIndex);
    if (!driving) this.emit(extracted);
    return extracted;
  }

  private pager(): PagerContext {
    const { host } = this;
    const live = host.windows.main;
    return {
      session: live,
      recipe: host.recipe,
      timeoutMs: host.timeoutMs,
      target: async () => {
        const { recipe, healing, timeoutMs } = host;
        if (this.targetSelectors) return (await resolvePaginationTarget(live, recipe, { timeoutMs, reuse: this.targetSelectors })).ref;
        // First use: the healing ladder, like a field; later pages reuse what it settled on.
        const result = await resolvePaginationTarget(live, recipe, {
          ladder: defaultLadder({ enabled: healing.enabled, extra: healing.resolvers }),
          promote: healing.enabled,
          timeoutMs,
        });
        host.report.pagination = {
          candidate: result.ref ? (result.selectors[0] ?? null) : null,
          outcome: result.outcome,
          ...(result.notes.length > 0 ? { notes: result.notes } : {}),
          ...(result.frame ? { frame: result.frame.report } : {}),
        };
        if (isHealed(result.outcome)) host.report.healed++;
        if (isHealed(result.frame?.outcome)) host.report.healed++;
        if (result.frame?.promotion) host.onHealed(this.page)(result.frame.promotion);
        if (result.promotion) host.onHealed(this.page)(result.promotion);
        if (result.ref) this.targetSelectors = { selectors: result.selectors, ...(result.frame ? { frame: result.frame.selectors } : {}) };
        return result.ref;
      },
      count: async () => {
        const name = this.paginating ? drivingTable(this.paginating, this.tables.map((t) => t.table)) : this.lead;
        const state = this.tables.find((t) => t.table.name === name);
        return countItems(live, state?.table ?? null, state?.resolved);
      },
      advancing: () => host.emitter.emit('page.advanced', { page: this.page + 1, kind: host.strategy.kind }),
      sleep: (ms) => host.sleep(ms),
    };
  }

  // Flows

  /** Run a called flow from the sequence, unless flows are off. */
  private async calledFlow(name: string): Promise<void> {
    if (!this.host.flowsEnabled) return;
    const flow = this.flows.get(name)!;
    await this.runFlow(flow, 'called', this.host.windows.main);
    this.batch.flowsRun.push(name);
  }

  private async runFlow(flow: Flow, kind: FlowKind, origin: Session): Promise<void> {
    const { host } = this;
    const page = this.page;
    const window = kind === 'reactive' ? await origin.url().catch(() => '') : undefined;
    host.emitter.emit('flow.started', { flow: flow.name, kind, page, ...(window !== undefined ? { window } : {}) });
    const entry = { name: flow.name, kind, page, outcome: 'ok' as 'ok' | 'failed', ...(window !== undefined ? { window } : {}), steps: [] as RunReport['steps'] };
    host.report.flows.push(entry);
    host.transition('stepping');
    try {
      const result = await runFlow(host.recipe, flow, origin, {
        page,
        windows: host.windows,
        ...(host.vars ? { vars: host.vars } : {}),
        timeoutMs: host.timeoutMs,
        ladder: defaultLadder({ enabled: host.healing.enabled, extra: host.healing.resolvers }),
        promote: host.healing.enabled,
        onHealed: host.onHealed(page),
        cache: this.cache,
        sleep: (ms) => host.sleep(ms),
        checkpoint: () => this.checkpoint(),
        awaitUser: (request) => this.awaitUser(request),
        onEvent: (step) => {
          entry.steps.push(step);
          host.report.steps.push(step);
          if (step.outcome === 'healed') host.report.healed++;
          if (step.outcome === 'skipped') host.emitter.emit('step.skipped', { page, step });
          else if (step.outcome !== 'failed') host.emitter.emit('step.replayed', { page, step });
        },
        // A step that navigated the main window lands on a new page, which may be walled.
        onNavigated: async (at) => {
          this.info = at;
          host.report.finalUrl = at.url;
          await this.guardLoad(at.url);
          return this.info;
        },
      });
      if (result.info) {
        this.info = result.info;
        host.report.finalUrl = result.info.url;
      }
    } catch (error) {
      entry.outcome = 'failed';
      host.emitter.emit('flow.done', { flow: flow.name, kind, page, outcome: 'failed' });
      throw error;
    }
    host.emitter.emit('flow.done', { flow: flow.name, kind, page, outcome: 'ok' });
  }

  /**
   * A checkpoint: fire the first reactive flow, in recipe order, whose trigger
   * resolves in any open window of the run. Nothing fires while a reactive
   * flow runs. A flow that would fire more than its `maxRetries` since the
   * last successful extraction fails the run with `flow-loop`.
   */
  async checkpoint(): Promise<void> {
    if (this.reacting || !this.host.flowsEnabled || this.reactive.length === 0) return;
    const windows = this.host.windows.open();
    for (const flow of this.reactive) {
      for (const window of windows) {
        if (!(await targetPresent(window, flow.trigger!.appears))) continue;
        const fired = (this.retries.get(flow.name) ?? 0) + 1;
        if (fired > maxRetriesOf(flow)) {
          throw new RunFailure('flow-loop', `reactive flow "${flow.name}" fired more than ${maxRetriesOf(flow)} times without a successful extraction in between`, [flow.name]);
        }
        this.retries.set(flow.name, fired);
        const from = this.host.state();
        this.reacting = true;
        try {
          await this.runFlow(flow, 'reactive', window);
        } finally {
          this.reacting = false;
        }
        if (flow.recover) await this.recover();
        this.host.transition(from);
        return;
      }
    }
  }

  // Extraction

  /** Extract one table on the main window's current page, after its guards. The rows are deduplicated, not emitted. */
  private async extract(name: string, fromIndex: number | undefined): Promise<Extracted> {
    const { host } = this;
    const { recipe } = host;
    await this.checkpoint();
    // A wall can show up without a navigation, such as an SPA's login form.
    await this.guardLoad();
    host.transition('extracting');
    const state = this.tables.find((t) => t.table.name === name)!;
    const live = host.windows.main;
    const page = this.page;
    const label = this.multi ? { label: name } : {};
    const run = (): Promise<TableExtraction> =>
      extractTable(live, recipe, state.table, {
        pageUrl: this.info.url,
        page,
        frameTimeoutMs: host.timeoutMs,
        ...label,
        ...(state.resolved ? { resolved: state.resolved } : {
          // A table not settled yet goes through the ladder; a settled one reuses its selectors.
          ladder: defaultLadder({ enabled: host.healing.enabled, extra: [...host.healing.resolvers, ...(host.repick ? [host.repick(page)] : [])] }),
          promote: host.healing.enabled,
          onHealed: host.onHealed(page),
        }),
        ...(fromIndex !== undefined ? { fromIndex } : {}),
      });
    let found = await run();
    // Nothing resolved on a short or errored page: an interstitial, not a redesign.
    const laterPage = state.resolved !== undefined;
    const zeroCtx = (at: PageInfo, extraction: TableExtraction) =>
      guardContext({ session: live, recipe, info: at, intendedUrl: this.batch.url, extraction: { tables: [extraction], promotions: [], resolved: [] }, laterPage });
    for (;;) {
      const match = await detect(host.detectors, 'extract', zeroCtx(this.info, found));
      if (!match) break;
      await this.pauseGuard(match, async (settled) =>
        detect(this.only(match.kind), 'extract', zeroCtx(settled, await extractTable(live, recipe, state.table, { pageUrl: settled.url, page, frameTimeoutMs: host.timeoutMs, ...label, ...(state.resolved ? { resolved: state.resolved } : {}) }))),
      );
      host.transition('extracting');
      found = await run();
    }
    this.settle(state, found);
    // A successful extraction gives every reactive flow its retries back.
    this.retries.clear();
    const fresh = state.dedup?.preview(found.rows, page) ?? { kept: found.rows, dropped: 0, commit: () => {} };
    return { found, fresh };
  }

  /** Report how a table resolved the first time, and apply the first extraction rules: required targets and rows. */
  private settle(state: TableState, found: TableExtraction): void {
    const { host } = this;
    const { report } = host;
    const page = this.page;
    const at = this.multi ? `table "${found.name}": ` : '';
    const first = state.resolved === undefined;
    const isNew = !state.resolved;
    if (isNew && (first || found.resolved)) {
      // First time the table resolves: report how.
      const table = report.tables.find((t) => t.name === found.name)!;
      table.item = found.item;
      table.fields = found.fields;
      if (found.frame) table.frame = found.frame;
      report.healed +=
        found.fields.filter((f) => isHealed(f.outcome)).length +
        (isHealed(found.item?.outcome) ? 1 : 0) +
        (isHealed(found.item?.within?.outcome) ? 1 : 0) +
        (isHealed(found.frame?.outcome) ? 1 : 0);
      if (found.name === this.mirror) {
        report.item = found.item;
        report.fields = found.fields;
      }
      for (const field of found.fields) host.emitter.emit('field.resolved', { page, table: found.name, field });
    }
    let names = found.missingRequired;
    if (first && found.name !== this.lead && (names.includes('item') || names.includes('within'))) {
      // A secondary list absent from the page is normal: no rows for it, not a failure.
      report.warnings.push(`${at}the item container matched no element on page ${page}; the table yields no rows`);
      names = names.filter((name) => name !== 'item' && name !== 'within');
    }
    if (first) {
      if (names.length > 0) {
        throw new RunFailure(
          'missing-required',
          at +
            (names.includes('within')
              ? 'the list parent (item.within) matched no element, so the item container is unresolved'
              : names.includes('item')
                ? 'the item container matched no element'
                : `required field${names.length > 1 ? 's' : ''} ${names.join(', ')} matched no element`),
          names,
        );
      }
      if (found.containerCount > 0 && found.rows.length === 0) {
        const causes = new Set(found.dropped.flatMap((d) => d.fields));
        const dropped = found.fields.map((f) => f.name).filter((name) => causes.has(name));
        throw new RunFailure('missing-required', `${at}every row on page ${page} was dropped for missing required field${dropped.length > 1 ? 's' : ''} ${dropped.join(', ')}`, dropped);
      }
    } else {
      // A later page with no items is the end of the list, not a failure; a field gone from every item is.
      const gone = names.filter((name) => name !== 'item' && name !== 'within');
      if (gone.length > 0) {
        throw new RunFailure('missing-required', `${at}required field${gone.length > 1 ? 's' : ''} ${gone.join(', ')} matched no element on page ${page}`, gone);
      }
    }
    if (isNew) state.resolved = found.resolved;
    report.warnings.push(...found.warnings);
  }

  /** Emit an extraction's rows and count them in the report. */
  private emit({ found, fresh }: Extracted): void {
    const { host } = this;
    const { report } = host;
    const page = this.page;
    fresh.commit();
    fresh.kept.forEach((row, at) => {
      row._index = at;
      host.rows.push(row);
      host.emitter.emit('row.emitted', { page, table: found.name, row });
    });
    const table = report.tables.find((t) => t.name === found.name)!;
    const state = this.tables.find((t) => t.table.name === found.name)!;
    table.rowCount += fresh.kept.length;
    table.duplicateCount = state.dedup?.duplicates ?? 0;
    table.droppedCount += found.dropped.length;
    let entry: PageReport | undefined = report.pages.find((p) => p.page === page);
    if (!entry) {
      entry = { page, url: this.info.url, rows: 0, dropped: 0, ...(this.multi ? { tables: [] } : {}) };
      report.pages.push(entry);
    }
    entry.rows += fresh.kept.length;
    entry.dropped += found.dropped.length;
    entry.tables?.push({ name: found.name, rows: fresh.kept.length, dropped: found.dropped.length });
    report.pageCount = Math.max(report.pageCount, page);
    report.rowCount = host.rows.length;
    report.duplicateCount = report.tables.find((t) => t.name === this.mirror)?.duplicateCount ?? 0;
    report.droppedCount += found.dropped.length;
  }

  // Pagination

  /** The page loop: run `do` on each page, then advance, until a stop rule, the limit, or the cap. */
  private async paginate(block: Paginate): Promise<StopReason> {
    const { host } = this;
    const { strategy } = host;
    const tables = this.tables.map((t) => t.table);
    const driving = drivingTable(block, tables);
    this.paginating = block;
    let previous: PageSummary | null = null;
    let fromIndex: number | undefined;
    try {
      for (;;) {
        const extracted: Extracted[] = [];
        for (const inner of block.do) {
          const result = await this.inner(inner, { name: driving, ...(fromIndex !== undefined ? { fromIndex } : {}) });
          if (result) extracted.push(result);
        }
        const page = this.page;
        const lead = extracted.find((e) => e.found.name === driving);
        const dedup = this.tables.find((t) => t.table.name === driving)?.dedup;
        // Without a driving table every page counts as one item, so only the limit, the cap, or a missing target stop the run.
        const summary: PageSummary =
          lead && dedup
            ? { page, url: this.info.url, firstKey: lead.found.firstRow ? dedup.keyOf(lead.found.firstRow) : null, raw: lead.found.containerCount, kept: lead.fresh.kept.length }
            : { page, url: this.info.url, firstKey: null, raw: 1, kept: 1 };
        const verdict = evaluateStop({ current: summary, previous, kind: strategy.kind, stopRules: block.stopRules, limit: host.limit, cap: host.cap });
        if (!verdict.discard) {
          for (const e of extracted) this.emit(e);
          const entry = host.report.pages.find((p) => p.page === page);
          host.emitter.emit('page.done', { page, rows: entry?.rows ?? 0 });
        }
        if (verdict.reason) return verdict.reason;

        if (host.delayMs > 0) await host.sleep(host.delayMs);
        host.transition('paginating');
        const advance = await strategy.next(this.pager(), page);
        if (advance.kind === 'stop') return advance.reason;
        previous = summary;
        this.page++;
        if (advance.kind === 'page') {
          fromIndex = undefined;
          host.transition('navigating');
          // Only a page the runner navigated to itself starts a new batch.
          if (strategy.kind === 'url') this.batch = { url: advance.url ?? advance.info.url, flowsRun: [] };
          await this.loaded(advance.info);
        } else {
          fromIndex = advance.from;
        }
      }
    } finally {
      this.paginating = null;
    }
  }

  // Guards, attention, and recovery

  private only(kind: GuardMatch['kind']): GuardDetector[] {
    return this.host.detectors.filter((d) => d.kind === kind);
  }

  /**
   * Load-phase guards on the main window's current page: pause until none
   * matches. `landing` is the page a step navigated to in the middle of a flow:
   * after the guard clears the run goes back there instead of recovering, since
   * the flow goes on from its next step.
   */
  private async guardLoad(landing?: string): Promise<void> {
    const { host } = this;
    if (host.detectors.length === 0) return;
    const live = host.windows.main;
    for (;;) {
      const ctx = (info: PageInfo) => guardContext({ session: live, recipe: host.recipe, info, intendedUrl: landing ?? this.batch.url });
      const match = await detect(host.detectors, 'load', ctx(this.info));
      if (!match) return;
      // A recovery that navigated has checked the new page's guards already.
      if (await this.pauseGuard(match, (settled) => detect(this.only(match.kind), 'load', ctx(settled)), landing)) return;
      host.report.finalUrl = this.info.url;
      host.emitter.emit('page.loaded', { page: this.page, url: this.info.url, title: this.info.title, status: this.info.status });
    }
  }

  /**
   * Pause on a guard until it clears, then restore the page state, or go back
   * to `landing` for a guard raised on the page a step navigated to. True when
   * a recovery navigated.
   */
  private async pauseGuard(match: GuardMatch, check: (info: PageInfo) => Promise<GuardMatch | null>, landing?: string): Promise<boolean> {
    const { host } = this;
    const live = host.windows.main;
    const from = host.state();
    host.transition('guarded');
    const lease = await host.acquireAttention();
    try {
      let cleared = false;
      if (lease.waited) {
        // Another run held attention; its user may have cleared this guard too.
        const url = landing ?? this.batch.url;
        const reloaded = await live.goto(url, { timeoutMs: host.timeoutMs }).catch(() => null);
        const settled = reloaded ?? (await live.settle({ timeoutMs: host.timeoutMs }).catch(() => null));
        if (settled) this.info = settled;
        cleared = settled !== null && (await check(settled).catch(() => match)) === null;
      }
      if (!cleared) await this.guardHeld(match, check, lease);
    } finally {
      lease.release();
    }
    if (landing !== undefined) {
      // The user may end up elsewhere, such as the home page after logging in; a login URL is never a page to go back to.
      if (!sameUrl(this.info.url, landing) && !LOGIN_URL_PATTERN.test(pathOf(landing))) this.info = await live.goto(landing, { timeoutMs: host.timeoutMs });
      host.transition(from);
      return false;
    }
    const navigated = await this.recover();
    host.transition(from);
    return navigated;
  }

  /** The guard pause proper, once the run holds attention. */
  private async guardHeld(match: GuardMatch, check: (info: PageInfo) => Promise<GuardMatch | null>, lease: AttentionLease): Promise<void> {
    const { host } = this;
    const { kind, reason } = match;
    const page = this.page;
    const url = this.info.url;
    host.emitter.emit('guard.raised', { kind, page, url, reason });
    host.needAttention({ reason: 'guard', page, url, kind });
    const result = await this.hold({
      kind,
      reason,
      window: host.windows.main,
      url,
      budget: host.budget,
      lease,
      notify: `${kind} guard on page ${page}: ${reason}`,
      check,
      abortMessage: 'the run was aborted while it waited for a guard',
    });
    host.report.guards.push({ kind, page, url, waitedMs: result.waitedMs, cleared: result.cleared });
    if (!result.cleared) {
      host.emitter.emit('guard.timeout', { kind, page, url, waitedMs: result.waitedMs });
      host.resolveAttention('timeout');
      throw new RunFailure('paused', `${kind} guard on page ${page} was not cleared within the guard timeout (${reason}): ${url}`);
    }
    host.emitter.emit('guard.cleared', { kind, page, url, waitedMs: result.waitedMs });
    host.resolveAttention('cleared');
    this.info = result.info;
  }

  /** An `await-user` step: hold the user's attention until its condition holds, on the run's budget or the step's own timeout. */
  private async awaitUser(request: AwaitUserRequest): Promise<void> {
    const { host } = this;
    const { step, window, label } = request;
    if (!(await request.stillNeeded())) return;
    const lease = await host.acquireAttention();
    try {
      // Another run held attention; a shared login may already satisfy the condition.
      if (lease.waited && !(await request.stillNeeded())) return;
      const page = this.page;
      const url = await window.url().catch(() => this.info.url);
      host.needAttention({ reason: 'await-user', page, url, label, flow: request.flow });
      const budget = step.timeoutMs !== undefined ? new GuardBudget(step.timeoutMs) : host.budget;
      const result = await this.hold({
        kind: 'await-user',
        label,
        reason: `waiting for you: ${label}`,
        window,
        url,
        budget,
        lease,
        notify: `${label} (page ${page})`,
        check: async () => ((await request.stillNeeded()) ? true : null),
        // The condition needs no settled page, and the step's window may close once the user is done.
        settle: async () => this.info,
        abortMessage: `the run was aborted while it waited for the user (${label})`,
      });
      if (!result.cleared) {
        host.resolveAttention('timeout');
        throw new RunFailure('paused', `await-user step "${awaitUserLabel(request.flow, step, request.index)}" of flow "${request.flow}" was not completed within ${step.timeoutMs !== undefined ? `its timeout of ${step.timeoutMs} ms` : 'the guard timeout'}`);
      }
      host.resolveAttention('cleared');
    } finally {
      lease.release();
    }
  }

  /**
   * Hold the user's attention: focus the window, notify, show the banner, and
   * wait until `check` clears, Continue re-checks at once, Abort ends the run,
   * or the budget runs out. Reactive flows get a checkpoint on every tick.
   */
  private async hold(opts: {
    kind: AttentionKind;
    label?: string;
    reason: string;
    window: Session;
    url: string;
    budget: GuardBudget;
    lease: AttentionLease;
    notify: string;
    check: (info: PageInfo) => Promise<unknown>;
    settle?: () => Promise<PageInfo>;
    abortMessage: string;
  }): Promise<WaitResult> {
    const { host } = this;
    const { window, budget, lease } = opts;
    await quietly(() => window.focus());
    await quietly(() =>
      (host.notify ?? new NoopNotify()).notify({ title: `webscoop: ${host.recipe.name} needs you`, body: opts.notify, urgency: 'critical' }),
    );
    const recheck = new Recheck();
    const waitAbort = new AbortController();
    const onRunAbort = () => waitAbort.abort();
    host.signal?.addEventListener('abort', onRunAbort, { once: true });
    if (host.signal?.aborted) waitAbort.abort();
    let userAborted = false;
    let hooks: GuardBannerHooks | null = null;
    let offSignal = () => {};
    const banner = host.banner;
    try {
      let continued = false;
      const onContinue = () => {
        continued = true;
        recheck.trigger();
      };
      const onAbort = () => {
        userAborted = true;
        waitAbort.abort();
      };
      offSignal = lease.onSignal((sent) => (sent === 'continue' ? onContinue() : onAbort()));
      if (banner && !budget.exhausted) {
        // Without a banner the wait still works; polling alone clears it.
        hooks = await banner
          .show(window, {
            kind: opts.kind,
            ...(opts.label ? { label: opts.label } : {}),
            reason: opts.reason,
            page: this.page,
            url: opts.url,
            deadline: Date.now() + budget.remainingMs,
            ...(window !== host.windows.main ? { popup: true } : {}),
          })
          .catch(() => null);
        hooks?.onContinue(onContinue);
        hooks?.onAbort(onAbort);
      }
      return await waitForClear(opts.check, window, {
        budget,
        signal: waitAbort.signal,
        recheck,
        onTick: async () => {
          if (continued) {
            continued = false;
            lease.stillBlocked();
          }
          await this.checkpoint();
        },
        ...(opts.settle ? { settle: opts.settle } : {}),
        ...(host.pollMs !== undefined ? { pollMs: host.pollMs } : {}),
      });
    } catch (error) {
      if (userAborted) throw new RunFailure('aborted', opts.abortMessage);
      throw error;
    } finally {
      offSignal();
      host.signal?.removeEventListener('abort', onRunAbort);
      if (hooks) await quietly(() => banner!.hide());
    }
  }

  /**
   * Restore the state the sequence had built at the current point: go back to
   * where the batch began and replay the called flows it ran. Skipped when no
   * flow ran and the main window is already there. On page 2 or later of
   * `next` or `more` pagination the state cannot be rebuilt: the run fails
   * with `pagination-lost`. True when it navigated.
   */
  async recover(): Promise<boolean> {
    const { host } = this;
    const kind = this.paginating?.kind;
    if ((kind === 'next' || kind === 'more') && this.page >= 2) {
      throw new RunFailure('pagination-lost', `the page state of page ${this.page} cannot be rebuilt after an interruption, since ${kind} pagination reached it by clicking; rows of earlier pages are kept`);
    }
    const live = host.windows.main;
    const flows = [...this.batch.flowsRun];
    const current = await live.url().catch(() => '');
    if (flows.length === 0 && sameUrl(current, this.batch.url)) return false;
    host.transition('navigating');
    const info = await live.goto(this.batch.url, { timeoutMs: host.timeoutMs });
    this.batch.flowsRun = [];
    await this.loaded(info);
    for (const name of flows) await this.calledFlow(name);
    return true;
  }
}

/** Side effects such as notifications must never fail the run. */
export async function quietly(fn: () => Promise<void> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // Ignored on purpose.
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}
