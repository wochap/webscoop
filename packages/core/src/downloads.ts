import { DownloadError, type NextDownloadOptions, type SavedDownload, type Session } from './ports';

/** What an adapter reports once it saved a download, or why it could not. */
export type DownloadOutcome = Omit<SavedDownload, 'id' | 'origin'>;

interface Entry {
  id: number;
  done: Promise<SavedDownload>;
  saved?: SavedDownload;
  taken: boolean;
  settled: boolean;
}

/**
 * The download queue of a page and its popups, shared by their sessions.
 * Adapters add each download with the promise of its saved file; steps take
 * them in start order with `next`.
 */
export class DownloadQueue {
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<(download: SavedDownload) => void>();
  private readonly waiters = new Set<() => void>();

  constructor(
    /** Renames a saved file in its directory, with the ` (n)` collision rule. */
    private readonly rename: (download: SavedDownload, name: string) => Promise<DownloadOutcome>,
  ) {}

  mark(): number {
    return this.entries.length;
  }

  /** Queue a download whose file is being saved. */
  add(origin: Session, saving: Promise<DownloadOutcome>): void {
    const id = this.entries.length;
    const entry: Entry = { id, taken: false, settled: false, done: Promise.resolve() as unknown as Promise<SavedDownload> };
    entry.done = saving.then(
      (outcome) => {
        const saved: SavedDownload = { ...outcome, id, origin };
        entry.saved = saved;
        entry.settled = true;
        for (const cb of [...this.listeners]) cb(saved);
        return saved;
      },
      (error: unknown) => {
        entry.settled = true;
        throw new DownloadError(`the download failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    entry.done.catch(() => {});
    this.entries.push(entry);
    for (const wake of [...this.waiters]) wake();
  }

  async next(opts: NextDownloadOptions): Promise<SavedDownload> {
    const deadline = Date.now() + opts.timeoutMs;
    let entry = this.untaken(opts.since);
    while (!entry) {
      const left = deadline - Date.now();
      if (left <= 0) throw new DownloadError(`no download started within ${opts.timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
      entry = this.untaken(opts.since);
    }
    entry.taken = true;
    const left = Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DownloadError(`the download did not finish within ${opts.timeoutMs} ms`)), left);
    });
    try {
      const saved = await Promise.race([entry.done, timeout]);
      if (opts.name === undefined || opts.name === saved.name) return saved;
      const renamed: SavedDownload = { ...(await this.rename(saved, opts.name)), id: saved.id, origin: saved.origin };
      entry.saved = renamed;
      return renamed;
    } finally {
      clearTimeout(timer);
    }
  }

  onSaved(cb: (download: SavedDownload) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async settle(timeoutMs: number): Promise<void> {
    const pending = this.entries.filter((e) => !e.settled).map((e) => e.done.catch(() => {}));
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(pending), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  private untaken(since: number): Entry | undefined {
    return this.entries.find((e) => !e.taken && e.id >= since);
  }
}

/** Why a step's file name cannot be used, or null when it can. */
export function downloadNameProblem(name: string): string | null {
  if (name.trim() === '') return 'the file name is empty';
  if (name.includes('/') || name.includes('\\')) return `the file name ${JSON.stringify(name)} holds a directory separator`;
  if (name === '.' || name === '..') return `the file name ${JSON.stringify(name)} is not a file name`;
  return null;
}
