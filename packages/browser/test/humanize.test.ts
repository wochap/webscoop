import { describe, expect, it } from 'vitest';
import { DWELL, Humanizer, KEY, THINK, TYPING_CAP_MS, speedFromEnv, type Box, type HumanPage, type HumanTarget } from '../src/humanize';
import { PlaywrightSession, plainHover } from '../src/playwright-browser';

/** Mulberry32: a small seeded uniform random source. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scene {
  calls: string[];
  moves: { x: number; y: number }[];
  typed: string[];
  wheels: number[];
  slept: number[];
  scroll: { y: number; view: number; height: number };
  /** The page ignores wheel events, like an endless feed that never ends. */
  stuck?: boolean;
}

function fakePage(scene: Scene): HumanPage {
  return {
    mouse: {
      move: async (x, y) => {
        scene.moves.push({ x, y });
        scene.calls.push('move');
      },
      down: async () => void scene.calls.push('down'),
      up: async () => void scene.calls.push('up'),
      wheel: async (_dx, dy) => {
        scene.wheels.push(dy);
        scene.calls.push('wheel');
        if (!scene.stuck) scene.scroll.y = Math.max(0, Math.min(scene.scroll.height - scene.scroll.view, scene.scroll.y + dy));
      },
    },
    keyboard: {
      type: async (text) => void scene.typed.push(text),
      press: async (key) => void scene.calls.push(`press:${key}`),
    },
    evaluate: async <R>(fn: () => R): Promise<R> => {
      const src = fn.toString();
      if (src.includes('scrollTo')) {
        scene.calls.push('scrollTo');
        scene.scroll.y = scene.scroll.height - scene.scroll.view;
        return undefined as R;
      }
      if (src.includes('scrollY')) return { ...scene.scroll } as R;
      return { width: 1200, height: 800 } as R;
    },
  };
}

function setup(seed = 1, scroll = { y: 0, view: 800, height: 4000 }) {
  const scene: Scene = { calls: [], moves: [], typed: [], wheels: [], slept: [], scroll };
  const humanizer = new Humanizer(fakePage(scene), {
    random: seeded(seed),
    sleep: async (ms) => void scene.slept.push(ms),
    speed: 1,
  });
  return { scene, humanizer };
}

const BOX: Box = { x: 400, y: 300, width: 120, height: 40 };

/** Hover spots that receive events: a covered center rejects center hovers, no spot rejects every hover. */
function target(scene: Scene, box: Box | null = BOX, spots: ('center' | 'inset')[] = ['center', 'inset']): HumanTarget {
  return {
    hover: async (o) => {
      const spot = o?.position ? 'inset' : 'center';
      scene.calls.push(`${o?.trial ? 'trial-hover' : 'hover'}:${spot}`);
      if (!spots.includes(spot)) throw new Error('element is covered');
    },
    scrollIntoViewIfNeeded: async () => void scene.calls.push('scrollIntoView'),
    boundingBox: async () => box,
    click: async (o) => void scene.calls.push(o?.trial ? 'trial' : 'click'),
    fill: async (v) => void scene.calls.push(`fill:${v}`),
    inputValue: async () => 'old',
    press: async (k) => void scene.calls.push(`locator.press:${k}`),
    selectOption: async (o) => void scene.calls.push(`select:${o.value}`),
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
function skewness(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const m2 = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  const m3 = xs.reduce((a, b) => a + (b - mean) ** 3, 0) / xs.length;
  return m3 / m2 ** 1.5;
}

describe('Humanizer delays', () => {
  const { humanizer } = setup(7);
  for (const [name, preset, lo, hi] of [
    ['think', THINK, 300, 900],
    ['key', KEY, 60, 180],
    ['dwell', DWELL, 800, 2500],
  ] as const) {
    it(`samples ${name} within its clamp, with the median in range and a long tail`, () => {
      const xs = Array.from({ length: 10_000 }, () => humanizer.delay(preset));
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(preset.min);
      expect(Math.max(...xs)).toBeLessThanOrEqual(preset.max);
      expect(median(xs)).toBeGreaterThanOrEqual(lo);
      expect(median(xs)).toBeLessThanOrEqual(hi);
      expect(skewness(xs)).toBeGreaterThan(0);
    });
  }

  it('holds the button 40 to 200 ms', () => {
    const xs = Array.from({ length: 5000 }, () => humanizer.hold());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...xs)).toBeLessThanOrEqual(200);
  });

  it('reads the speed factor from the environment', () => {
    expect(speedFromEnv({ WEBSCOOP_HUMANIZE_SPEED: '20' })).toBe(20);
    expect(speedFromEnv({ WEBSCOOP_HUMANIZE_SPEED: 'fast' })).toBe(1);
    expect(speedFromEnv({})).toBe(1);
  });
});

describe('Humanizer pointer path', () => {
  it('curves through at least 12 points and ends inside the inner 80% of the box', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { scene, humanizer } = setup(seed);
      await humanizer.click(target(scene));
      const downAt = scene.calls.indexOf('down');
      const moves = scene.moves;
      expect(moves.length).toBeGreaterThanOrEqual(12);
      expect(scene.calls.slice(0, downAt).filter((c) => c === 'move').length).toBe(moves.length);
      const end = moves.at(-1)!;
      expect(end.x).toBeGreaterThanOrEqual(BOX.x + BOX.width * 0.1);
      expect(end.x).toBeLessThanOrEqual(BOX.x + BOX.width * 0.9);
      expect(end.y).toBeGreaterThanOrEqual(BOX.y + BOX.height * 0.1);
      expect(end.y).toBeLessThanOrEqual(BOX.y + BOX.height * 0.9);
      // Not collinear: some point is well off the straight line from start to end.
      const start = moves[0]!;
      const len = Math.hypot(end.x - start.x, end.y - start.y) || 1;
      const off = Math.max(...moves.map((p) => Math.abs((end.x - start.x) * (start.y - p.y) - (start.x - p.x) * (end.y - start.y)) / len));
      expect(off).toBeGreaterThan(2);
      expect(scene.calls).toEqual(expect.arrayContaining(['trial', 'scrollIntoView', 'down', 'up']));
      expect(scene.calls).not.toContain('click');
    }
  });

  it('does not always end at the centre', async () => {
    const ends = new Set<string>();
    for (let seed = 1; seed <= 5; seed++) {
      const { scene, humanizer } = setup(seed);
      await humanizer.click(target(scene));
      const end = scene.moves.at(-1)!;
      ends.add(`${Math.round(end.x)},${Math.round(end.y)}`);
    }
    expect(ends.size).toBeGreaterThan(1);
  });

  it('falls back to a plain click without a box', async () => {
    const { scene, humanizer } = setup();
    await humanizer.click(target(scene, null));
    expect(scene.calls).toEqual(['scrollIntoView', 'trial', 'click']);
  });
});

describe('Humanizer typing', () => {
  it('clears the target and types one key per character', async () => {
    const { scene, humanizer } = setup();
    await humanizer.type(target(scene), 'shoes');
    expect(scene.calls).toContain('fill:');
    expect(scene.typed).toEqual(['s', 'h', 'o', 'e', 's']);
  });

  it('caps a long value to 20 s of total key delay', () => {
    const { humanizer } = setup();
    const delays = humanizer.keyDelays('word '.repeat(100));
    expect(delays).toHaveLength(500);
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TYPING_CAP_MS + 1e-6);
  });
});

describe('Humanizer scroll and dwell', () => {
  it('wheels down in uneven steps until the bottom', async () => {
    const { scene, humanizer } = setup(3);
    await humanizer.scroll();
    expect(scene.wheels.length).toBeGreaterThan(1);
    expect(new Set(scene.wheels.map(Math.round)).size).toBeGreaterThan(1);
    expect(scene.calls).not.toContain('scrollTo');
    expect(scene.scroll.y + scene.scroll.view).toBeGreaterThanOrEqual(scene.scroll.height - 2);
  });

  it('jumps to the bottom at the step cap', async () => {
    const { scene, humanizer } = setup(3, { y: 0, view: 800, height: 4000 });
    scene.stuck = true;
    await humanizer.scroll();
    expect(scene.wheels).toHaveLength(20);
    expect(scene.calls.at(-1)).toBe('scrollTo');
  });

  it('makes at least one pointer move while dwelling', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { scene, humanizer } = setup(seed);
      await humanizer.dwell();
      expect(scene.moves.length).toBeGreaterThan(0);
    }
  });
});

describe('PlaywrightSession with humanized input', () => {
  function session(humanize: boolean) {
    const calls: string[] = [];
    const locator = {
      scrollIntoViewIfNeeded: async () => void calls.push('scrollIntoView'),
      click: async () => void calls.push('click'),
      fill: async (v: string) => void calls.push(`fill:${v}`),
      press: async (k: string) => void calls.push(`press:${k}`),
    };
    const page = { on() {}, keyboard: { press: async (k: string) => void calls.push(`keyboard:${k}`) }, evaluate: async () => void calls.push('scrollTo') };
    const humanizer = {
      click: async () => void calls.push('h.click'),
      type: async (_t: unknown, v: string) => void calls.push(`h.type:${v}`),
      press: async (k: string) => void calls.push(`h.press:${k}`),
      scroll: async () => void calls.push('h.scroll'),
    };
    const s = new PlaywrightSession({} as never, page as never, 'playwright', humanize ? (humanizer as never) : undefined);
    const ref = { locator, description: 'x' } as never;
    return { s, ref, calls };
  }

  it('keeps the plain Playwright calls when off', async () => {
    const { s, ref, calls } = session(false);
    await s.click(ref);
    await s.fill(ref, 'a');
    await s.press('Enter', ref);
    await s.press('Tab');
    await s.scrollToBottom();
    expect(calls).toEqual(['scrollIntoView', 'click', 'fill:a', 'press:Enter', 'keyboard:Tab', 'scrollTo']);
  });

  it('routes actions through the humanizer when on', async () => {
    const { s, ref, calls } = session(true);
    await s.click(ref);
    await s.fill(ref, 'a');
    await s.press('Enter', ref);
    await s.scrollToBottom();
    expect(calls).toEqual(['h.click', 'h.type:a', 'h.press:Enter', 'h.scroll']);
  });
});

describe('hover', () => {
  it('humanized: moves into the box and dwells 80 to 250 ms', async () => {
    const { scene, humanizer } = setup(3);
    await humanizer.hover(target(scene));
    expect(scene.calls[0]).toBe('scrollIntoView');
    expect(scene.calls[1]).toBe('trial-hover:center');
    const last = scene.moves.at(-1)!;
    expect(last.x).toBeGreaterThanOrEqual(BOX.x + BOX.width * 0.1);
    expect(last.x).toBeLessThanOrEqual(BOX.x + BOX.width * 0.9);
    expect(scene.moves.length).toBeGreaterThanOrEqual(12);
    const dwell = scene.slept.at(-1)!;
    expect(dwell).toBeGreaterThanOrEqual(80);
    expect(dwell).toBeLessThanOrEqual(250);
    expect(scene.calls).not.toContain('down');
  });

  it('humanized: a covered center falls back to the top-left inset', async () => {
    const { scene, humanizer } = setup(4);
    await humanizer.hover(target(scene, BOX, ['inset']));
    expect(scene.calls.slice(1, 3)).toEqual(['trial-hover:center', 'trial-hover:inset']);
    expect(scene.moves.at(-1)).toEqual({ x: BOX.x + 2, y: BOX.y + 2 });
  });

  it('humanized: returns quietly without a box or a hoverable spot', async () => {
    const { scene, humanizer } = setup(5);
    await humanizer.hover(target(scene, null));
    await humanizer.hover(target(scene, BOX, []));
    expect(scene.moves).toEqual([]);
    expect(scene.slept).toEqual([]);
  });

  it('plain: hovers the center and waits one frame', async () => {
    const { scene } = setup();
    const frames: string[] = [];
    await plainHover(target(scene), { evaluate: async () => void frames.push('frame') as never });
    expect(scene.calls).toEqual(['hover:center']);
    expect(frames).toEqual(['frame']);
  });

  it('plain: a covered center falls back to the inset', async () => {
    const { scene } = setup();
    await plainHover(target(scene, BOX, ['inset']), { evaluate: async () => undefined as never });
    expect(scene.calls).toEqual(['hover:center', 'hover:inset']);
  });

  it('plain: gives up quietly when nothing receives events', async () => {
    const { scene } = setup();
    const frames: string[] = [];
    await plainHover(target(scene, null, []), { evaluate: async () => void frames.push('frame') as never });
    expect(scene.calls).toEqual(['hover:center', 'hover:inset']);
    expect(frames).toEqual([]);
  });

  it('PlaywrightSession routes hover through the humanizer when on', async () => {
    const calls: string[] = [];
    const locator = { hover: async () => void calls.push('hover') };
    const page = { on() {}, evaluate: async () => undefined };
    const humanizer = { hover: async () => void calls.push('h.hover') };
    const ref = { locator, description: 'x' } as never;
    await new PlaywrightSession({} as never, page as never, 'playwright', humanizer as never).hover(ref);
    await new PlaywrightSession({} as never, page as never, 'playwright').hover(ref);
    expect(calls).toEqual(['h.hover', 'hover']);
  });
});
