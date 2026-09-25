import type { HealOutcome } from './healing/types';
import type { StopReason } from './pagination/types';
import type { StepReport } from './steps/replay';
import type { Fingerprint, FieldType, GuardKind, PaginationKind, SelectorCandidate } from './recipe/schema';

export type FieldStatus = 'ok' | 'healed' | 'partial' | 'missing';

export type Row = Record<string, unknown> & { _page: number; _index: number };

/** `paused`: a guard was not cleared within the run's guard timeout. */
export type FailureReason = 'missing-required' | 'invalid-input' | 'timeout' | 'aborted' | 'paused' | 'error';

/** One guard occurrence: a page that asked for a human. */
export interface GuardEntry {
  kind: GuardKind;
  page: number;
  /** URL where the guard was detected. */
  url: string;
  /** How long the run waited for the guard to clear. */
  waitedMs: number;
  /** False when the guard timeout elapsed first. */
  cleared: boolean;
}

export interface FieldReport {
  name: string;
  type: FieldType;
  optional: boolean;
  /** Index into the field's selector list of the candidate that resolved, or null when none did. */
  candidateIndex: number | null;
  candidate: SelectorCandidate | null;
  /** Which rung of the healing ladder resolved the field. */
  outcome: HealOutcome;
  status: FieldStatus;
  /** Rows (0-based `_index`) where the field resolved nothing. */
  missingRows: number[];
  /** Why healing rungs declined the field, such as the model's reason for picking nothing. */
  notes?: string[];
}

export interface RunReport {
  recipe: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  finalUrl: string | null;
  pageCount: number;
  rowCount: number;
  item: {
    candidateIndex: number | null;
    candidate: SelectorCandidate | null;
    count: number;
    outcome: HealOutcome;
    /** Why healing rungs declined the item container. */
    notes?: string[];
    /** How the list parent (`item.within`) resolved, for a recipe that has one. */
    within?: {
      candidateIndex: number | null;
      candidate: SelectorCandidate | null;
      outcome: HealOutcome;
      notes?: string[];
    };
  } | null;
  fields: FieldReport[];
  /** How the pagination target resolved, when the run needed it. */
  pagination: {
    candidate: SelectorCandidate | null;
    outcome: HealOutcome;
    notes?: string[];
  } | null;
  /** Rows dropped because an earlier page already had them. */
  duplicateCount: number;
  /** Why the page loop ended, or null when the run failed before it did. */
  stopReason: StopReason | null;
  /** Every extracted page: its URL and the rows it contributed after dedup. */
  pages: PageReport[];
  warnings: string[];
  /** Targets (item container, fields, pagination target, step targets) resolved by a rung other than their first candidate. */
  healed: number;
  /** Path the promoted recipe was written to, or null when it was not written. */
  savedTo: string | null;
  /** Every guard raised during the run, in order. */
  guards: GuardEntry[];
  /** Every step replay, in the order it ran; `every-page` steps appear once per page. */
  steps: StepReport[];
}

export interface PageReport {
  page: number;
  url: string;
  rows: number;
}

/** What a re-pick asks the user about. */
export interface RepickInfo {
  page: number;
  /** Field name, `item`, or `pagination`. */
  target: string;
  oldSelector: SelectorCandidate;
  fingerprint: Fingerprint | null;
}

export interface RunEvents {
  'run.start': { recipe: string; url: string; profileDir: string; at: string };
  'page.loaded': { page: number; url: string; title: string; status: number | null };
  'guard.raised': { kind: GuardKind; page: number; url: string; reason: string };
  'guard.cleared': { kind: GuardKind; page: number; url: string; waitedMs: number };
  'guard.timeout': { kind: GuardKind; page: number; url: string; waitedMs: number };
  /** A step ran; `step.outcome` is `ok` or `healed`. */
  'step.replayed': { page: number; step: StepReport };
  /** An optional step found no target (or could not run) and was left out. */
  'step.skipped': { page: number; step: StepReport };
  'field.resolved': { page: number; field: FieldReport };
  'field.healed': {
    page: number;
    /** Field name, `item`, `pagination`, or a step's label or `step:N`. */
    target: string;
    outcome: HealOutcome;
    oldPrimary: SelectorCandidate;
    newPrimary: SelectorCandidate;
  };
  'repick.requested': RepickInfo;
  'repick.resolved': { page: number; target: string; result: 'picked' | 'skip' | 'abort' };
  'row.emitted': { page: number; row: Row };
  'page.done': { page: number; rows: number };
  /** Emitted right before the action that loads page `page`. */
  'page.advanced': { page: number; kind: PaginationKind };
  /** Emitted once, when the page loop ends; `page` is the last page extracted. */
  'pagination.stopped': { page: number; reason: StopReason };
  'recipe.saved': { path: string };
  'run.done': { report: RunReport };
  'run.failed': { reason: FailureReason; message: string; fields?: string[]; report: RunReport };
}

export type RunEventName = keyof RunEvents;

export const RUN_EVENT_NAMES: readonly RunEventName[] = [
  'run.start',
  'page.loaded',
  'guard.raised',
  'guard.cleared',
  'guard.timeout',
  'step.replayed',
  'step.skipped',
  'field.resolved',
  'field.healed',
  'repick.requested',
  'repick.resolved',
  'row.emitted',
  'page.done',
  'page.advanced',
  'pagination.stopped',
  'recipe.saved',
  'run.done',
  'run.failed',
];

type Listener<P> = (payload: P) => void;
type AnyListener<E> = <K extends keyof E>(name: K, payload: E[K]) => void;

/** Synchronous, typed, in-process event emitter. Listener errors do not affect the emitter's owner. */
export class Emitter<E extends object> {
  private readonly listeners = new Map<keyof E, Set<Listener<never>>>();
  private readonly anyListeners = new Set<AnyListener<E>>();

  on<K extends keyof E>(name: K, listener: Listener<E[K]>): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  onAny(listener: AnyListener<E>): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    for (const listener of this.listeners.get(name) ?? []) {
      try {
        (listener as Listener<E[K]>)(payload);
      } catch {
        // A faulty subscriber must not change runner behavior.
      }
    }
    for (const listener of this.anyListeners) {
      try {
        listener(name, payload);
      } catch {
        // Same as above.
      }
    }
  }
}

export class RunEmitter extends Emitter<RunEvents> {}

export interface RecordedEvent<K extends RunEventName = RunEventName> {
  name: K;
  payload: RunEvents[K];
}

/** Record every event from an emitter, for tests and diagnostics. */
export function recordEvents(emitter: RunEmitter) {
  const events: RecordedEvent[] = [];
  const stop = emitter.onAny((name, payload) => events.push({ name, payload }));
  return {
    events,
    stop,
    names: () => events.map((e) => e.name),
    /** Event names with consecutive repeats collapsed, e.g. `field.resolved` x5 becomes one entry. */
    sequence: () => events.map((e) => e.name).filter((name, i, all) => i === 0 || all[i - 1] !== name),
    of: <K extends RunEventName>(name: K): RunEvents[K][] =>
      events.filter((e) => e.name === name).map((e) => e.payload as RunEvents[K]),
  };
}
