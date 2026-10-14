import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CooldownSettings } from './config';
import { stateDir } from './daemon/paths';
import type { Env } from './paths';

/** The wall that made a recipe cold. */
export interface ColdGuard {
  kind: string;
  page: number;
  url: string;
}

/** One recipe's cold state, as stored. Times are epoch milliseconds. */
export interface CooldownEntry extends ColdGuard {
  since: number;
  until: number;
  streak: number;
  /** A refused run of this cold period already sent the notification. */
  notified: boolean;
}

/** Where cold state lives: `cooldowns.json` in the state directory. */
export function cooldownsPath(env: Env, homedir: string): string {
  return join(stateDir(env, homedir), 'cooldowns.json');
}

/**
 * Cold recipes in `cooldowns.json`, read on every call and written whole
 * through a rename. An entry stays until a clean run resets it, so its streak
 * survives the end of a period; a recipe is cold while `until` is ahead.
 */
export class CooldownStore {
  constructor(
    readonly path: string,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  /** Every entry; a missing file is empty, a malformed one is empty with a warning. */
  read(): Record<string, CooldownEntry> {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return {};
    }
    try {
      const data = JSON.parse(text) as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
      const out: Record<string, CooldownEntry> = {};
      for (const [recipe, e] of Object.entries(data as Record<string, Partial<CooldownEntry>>)) {
        if (!e || typeof e.until !== 'number' || typeof e.since !== 'number' || typeof e.streak !== 'number') continue;
        out[recipe] = { kind: String(e.kind ?? ''), page: Number(e.page ?? 1), url: String(e.url ?? ''), since: e.since, until: e.until, streak: e.streak, notified: e.notified === true };
      }
      return out;
    } catch (error) {
      this.warn(`ignoring malformed ${this.path}: ${(error as Error).message}`);
      return {};
    }
  }

  private write(entries: Record<string, CooldownEntry>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(temp, this.path);
  }

  /** The recipe's entry while it is cold, else null. */
  cold(recipe: string, now: number): CooldownEntry | null {
    const entry = this.read()[recipe];
    return entry && entry.until > now ? entry : null;
  }

  /** Cold entries, by recipe. */
  coldAll(now: number): [string, CooldownEntry][] {
    return Object.entries(this.read()).filter(([, e]) => e.until > now);
  }

  /** Make the recipe cold for its next period: the base doubled per earlier period of the streak, capped. */
  goCold(recipe: string, guard: ColdGuard, settings: CooldownSettings, now: number): CooldownEntry {
    const entries = this.read();
    const streak = (entries[recipe]?.streak ?? 0) + 1;
    const period = Math.min(settings.baseMs * 2 ** (streak - 1), settings.maxMs);
    const entry: CooldownEntry = { kind: guard.kind, page: guard.page, url: guard.url, since: now, until: now + period, streak, notified: false };
    entries[recipe] = entry;
    this.write(entries);
    return entry;
  }

  /** End the recipe's cold period, keeping its streak. False when it was not cold. */
  warm(recipe: string, now: number): boolean {
    const entries = this.read();
    const entry = entries[recipe];
    if (!entry || entry.until <= now) return false;
    entry.until = now;
    this.write(entries);
    return true;
  }

  /** Forget the recipe: warm, with no streak. */
  reset(recipe: string): void {
    const entries = this.read();
    if (!(recipe in entries)) return;
    delete entries[recipe];
    this.write(entries);
  }

  /** Mark the cold period as notified. True when this call marked it, false when it already was or the recipe is warm. */
  markNotified(recipe: string, now: number): boolean {
    const entries = this.read();
    const entry = entries[recipe];
    if (!entry || entry.until <= now || entry.notified) return false;
    entry.notified = true;
    this.write(entries);
    return true;
  }
}

/** Local wall-clock time, `HH:MM:SS`. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}
