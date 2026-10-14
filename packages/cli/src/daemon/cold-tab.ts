import {
  detect,
  enabledDetectors,
  GUARD_POLL_MS,
  GuardBudget,
  guardContext,
  Recheck,
  waitForClear,
  type GuardBannerHandler,
  type GuardBannerHooks,
  type PageInfo,
  type Recipe,
  type Session,
} from '@webscoop/core';
import type { CooldownEntry } from '../cooldown';

/** What a job leaves behind when it makes its recipe cold: the walled tab and what to watch on it. */
export interface ColdTabSource {
  session: Session;
  recipe: Recipe;
  /** Banner of the job's run; unset when `guards.banner` is false. */
  banner?: GuardBannerHandler;
}

export type ColdTabEnd = 'cleared' | 'expired' | 'closed' | 'disposed';

export interface ColdTabOptions {
  entry: CooldownEntry;
  /** Called once when the watch ends; the tab is already closed, except on 'closed'. */
  onEnd(end: ColdTabEnd): void;
  /** Interval between re-checks. Default 1000. */
  pollMs?: number;
  now?: () => number;
}

/**
 * A cold recipe's walled tab: kept open so the user can clear the wall, and
 * re-checked with the guard's detector every poll, without navigating, until
 * the guard clears, the period ends, the user closes the tab, or it is
 * disposed.
 */
export class ColdTab {
  private readonly abort = new AbortController();
  private readonly recheck = new Recheck();
  private ended = false;
  readonly done: Promise<void>;

  constructor(
    private readonly source: ColdTabSource,
    private readonly opts: ColdTabOptions,
  ) {
    this.done = this.watch();
  }

  get session(): Session {
    return this.source.session;
  }

  /** Bring the tab to the front. */
  async focus(): Promise<void> {
    await this.source.session.focus().catch(() => {});
  }

  /** Stop watching and close the tab. */
  async dispose(): Promise<void> {
    this.abort.abort();
    await this.done;
  }

  private async watch(): Promise<void> {
    const { session, recipe, banner } = this.source;
    const { entry } = this.opts;
    const now = this.opts.now ?? Date.now;
    const detectors = enabledDetectors(recipe).filter((d) => d.kind === entry.kind);
    const check = (info: PageInfo) => detect(detectors, 'load', guardContext({ session, recipe, info, intendedUrl: entry.url }));
    let hooks: GuardBannerHooks | null = null;
    let end = 'expired' as ColdTabEnd;
    if (banner) {
      hooks = await banner
        .show(session, { kind: entry.kind as never, reason: `cold until the wall clears`, page: entry.page, url: entry.url, deadline: entry.until, cold: true, popup: true })
        .catch(() => null);
      hooks?.onContinue(() => this.recheck.trigger());
    }
    try {
      const result = await waitForClear(check, session, {
        budget: new GuardBudget(entry.until - now()),
        pollMs: this.opts.pollMs ?? GUARD_POLL_MS,
        signal: this.abort.signal,
        recheck: this.recheck,
        now,
        onTick: () => {
          if (session.isClosed()) {
            end = 'closed';
            this.abort.abort();
          }
        },
      });
      end = result.cleared ? 'cleared' : 'expired';
    } catch {
      if (end !== 'closed') end = session.isClosed() ? 'closed' : 'disposed';
    }
    if (end !== 'closed') {
      if (hooks) await banner!.hide().catch(() => {});
      await session.close().catch(() => {});
    }
    this.finish(end);
  }

  private finish(end: ColdTabEnd): void {
    if (this.ended) return;
    this.ended = true;
    this.opts.onEnd(end);
  }
}
