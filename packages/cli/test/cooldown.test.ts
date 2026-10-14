import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CooldownStore } from '../src/cooldown';
import { tempDir } from './helpers';

const GUARD = { kind: 'captcha', page: 2, url: 'https://shop.test/c?page=2' };
const SETTINGS = { baseMs: 60_000, maxMs: 180_000 };

async function store(warnings: string[] = []) {
  return new CooldownStore(join(await tempDir(), 'state', 'cooldowns.json'), (m) => warnings.push(m));
}

describe('CooldownStore', () => {
  it('doubles the period per repeat, up to the cap', async () => {
    const s = await store();
    const periods: number[] = [];
    let now = 0;
    for (let i = 0; i < 4; i++) {
      const entry = s.goCold('shop', GUARD, SETTINGS, now);
      periods.push(entry.until - entry.since);
      now = entry.until + 1;
    }
    expect(periods).toEqual([60_000, 120_000, 180_000, 180_000]);
    expect(s.read().shop!.streak).toBe(4);
  });

  it('is cold until the period ends', async () => {
    const s = await store();
    s.goCold('shop', GUARD, SETTINGS, 1000);
    expect(s.cold('shop', 1000)).toMatchObject({ kind: 'captcha', page: 2, streak: 1 });
    expect(s.cold('shop', 61_000)).toBeNull();
    expect(s.cold('news', 1000)).toBeNull();
  });

  it('keeps the streak when warmed and drops it on reset', async () => {
    const s = await store();
    s.goCold('shop', GUARD, SETTINGS, 0);
    expect(s.warm('shop', 10)).toBe(true);
    expect(s.cold('shop', 10)).toBeNull();
    expect(s.goCold('shop', GUARD, SETTINGS, 20).streak).toBe(2);
    s.reset('shop');
    expect(s.read()).toEqual({});
    expect(s.goCold('shop', GUARD, SETTINGS, 30).streak).toBe(1);
    expect(s.warm('news', 30)).toBe(false);
  });

  it('marks a period notified once', async () => {
    const s = await store();
    s.goCold('shop', GUARD, SETTINGS, 0);
    expect(s.markNotified('shop', 1)).toBe(true);
    expect(s.markNotified('shop', 2)).toBe(false);
    expect(s.goCold('shop', GUARD, SETTINGS, 100_000).notified).toBe(false);
  });

  it('reads a malformed file as empty, with a warning', async () => {
    const warnings: string[] = [];
    const s = new CooldownStore(join(await tempDir(), 'cooldowns.json'), (m) => warnings.push(m));
    await writeFile(s.path, '{not json');
    expect(s.read()).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(s.goCold('shop', GUARD, SETTINGS, 0).streak).toBe(1);
  });
});
