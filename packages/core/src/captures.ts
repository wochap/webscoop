import type { CaptureReport, CaptureRow, CaptureStatus } from './events';
import type { RequestEvent } from './ports';
import type { Capture } from './recipe/schema';

/** A capture's regex: compiled without flags, found anywhere in the full request URL. */
export function compileCapture(match: string): RegExp {
  return new RegExp(match);
}

/** The status of a capture holding `rows` unique URLs. */
export function captureStatus(rows: number, count: number): CaptureStatus {
  return rows >= count ? 'ok' : rows > 0 ? 'partial' : 'missing';
}

interface Entry {
  capture: string;
  row: CaptureRow;
  done: boolean;
}

interface Slot {
  capture: Capture;
  regex: RegExp;
  /** By URL, in first-request order. */
  entries: Map<string, Entry>;
}

export interface CaptureSetOptions {
  /** The run's page number when a request is seen. */
  page: () => number;
  /** Called once per row, when it is complete. */
  onMatched: (capture: string, row: CaptureRow) => void;
}

/**
 * The captures of a run: tests every request against each capture, keeps one
 * row per unique URL, and completes a row when its first request gets a
 * response or fails, or when the run ends.
 */
export class CaptureSet {
  private readonly slots: Slot[];
  /** Rows waiting for the response of a request, by request id. */
  private readonly pending = new Map<string, Entry[]>();
  private readonly changed = new Set<() => void>();

  constructor(
    captures: readonly Capture[],
    private readonly opts: CaptureSetOptions,
  ) {
    this.slots = captures.map((capture) => ({ capture, regex: compileCapture(capture.match), entries: new Map() }));
  }

  get size(): number {
    return this.slots.length;
  }

  /** Feed a request or its update from `Session.onRequest`. */
  handle(event: RequestEvent): void {
    if (event.type === 'request') {
      let added = false;
      for (const slot of this.slots) {
        if (slot.entries.has(event.url) || !slot.regex.test(event.url)) continue;
        const entry: Entry = {
          capture: slot.capture.name,
          row: { url: event.url, method: event.method, status: null, mime: null, frame: event.frameUrl, _page: this.opts.page(), _index: slot.entries.size },
          done: false,
        };
        slot.entries.set(event.url, entry);
        const waiting = this.pending.get(event.id);
        if (waiting) waiting.push(entry);
        else this.pending.set(event.id, [entry]);
        added = true;
      }
      if (added) for (const cb of [...this.changed]) cb();
      return;
    }
    const waiting = this.pending.get(event.id);
    if (!waiting) return;
    this.pending.delete(event.id);
    for (const entry of waiting) {
      entry.row.status = event.failed ? null : event.status;
      entry.row.mime = event.failed ? null : event.mime;
      this.complete(entry);
    }
  }

  private complete(entry: Entry): void {
    if (entry.done) return;
    entry.done = true;
    this.opts.onMatched(entry.capture, entry.row);
  }

  /** Whether every required capture holds its count; optional ones never hold up the wait. */
  private full(): boolean {
    return this.slots.every((s) => s.capture.optional || s.entries.size >= s.capture.count);
  }

  /** Wait until every required capture holds its count, or `timeoutMs` passes. */
  settle(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.full() || timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.changed.delete(check);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const check = () => {
        if (this.full()) done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.changed.add(check);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** The run ended: complete every row still waiting for its response. */
  finish(): void {
    this.pending.clear();
    for (const slot of this.slots) for (const entry of slot.entries.values()) this.complete(entry);
  }

  /** Every row of a capture, in `_index` order. */
  rows(name: string): CaptureRow[] {
    return [...(this.slots.find((s) => s.capture.name === name)?.entries.values() ?? [])].map((e) => e.row);
  }

  report(): CaptureReport[] {
    return this.slots.map(({ capture, entries }) => ({
      name: capture.name,
      count: capture.count,
      optional: capture.optional,
      rows: entries.size,
      status: captureStatus(entries.size, capture.count),
    }));
  }
}
