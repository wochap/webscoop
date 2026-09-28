/**
 * Humanized input: pointer paths, typing rhythm, wheel scrolling, and think
 * times that look like a person instead of Playwright's instant actions.
 * Randomness and sleeping are injectable so tests are deterministic.
 */

export interface Point {
  x: number;
  y: number;
}

import { boxOf, type Box, type Measurable } from './box';

export type { Box };

/** The page surface the humanizer drives; a Playwright `Page` satisfies it. */
export interface HumanPage {
  mouse: {
    move(x: number, y: number): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
  };
  evaluate<R>(fn: () => R): Promise<R>;
}

/** The element surface the humanizer drives; a Playwright `Locator` satisfies it. */
export interface HumanTarget extends Measurable {
  scrollIntoViewIfNeeded(): Promise<void>;
  click(options?: { trial?: boolean }): Promise<void>;
  fill(value: string): Promise<void>;
  inputValue(): Promise<string>;
  press(key: string): Promise<void>;
  selectOption(option: { value: string }): Promise<unknown>;
}

export interface HumanizerOptions {
  /** Uniform random source in [0, 1). Default `Math.random`. */
  random?: () => number;
  /** Sleep for a number of ms. Default a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Divides every added delay; from `WEBSCOOP_HUMANIZE_SPEED` (test only). Default 1. */
  speed?: number;
}

/** A log-normal delay: median, spread, and clamp, in ms. */
export interface DelayPreset {
  median: number;
  sigma: number;
  min: number;
  max: number;
}

export const THINK: DelayPreset = { median: 550, sigma: 0.6, min: 120, max: 5000 };
export const KEY: DelayPreset = { median: 110, sigma: 0.45, min: 35, max: 600 };
export const DWELL: DelayPreset = { median: 1400, sigma: 0.5, min: 400, max: 6000 };
/** Wheel step size in px. */
const WHEEL: DelayPreset = { median: 380, sigma: 0.35, min: 200, max: 700 };
/** Longest total typing delay for one value longer than `LONG_VALUE`, in ms. */
export const TYPING_CAP_MS = 20_000;
const LONG_VALUE = 200;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Speed factor from the environment; ignores anything that is not a positive number. */
export function speedFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.WEBSCOOP_HUMANIZE_SPEED);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Minimum-jerk easing: speed rises and falls along the path. */
export function minimumJerk(t: number): number {
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
}

export class Humanizer {
  private readonly random: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly speed: number;
  private pointer: Point | undefined;

  constructor(
    private readonly page: HumanPage,
    opts: HumanizerOptions = {},
  ) {
    this.random = opts.random ?? Math.random;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.speed = opts.speed ?? speedFromEnv();
  }

  /** A standard normal sample (Box-Muller). */
  normal(): number {
    const u = Math.max(this.random(), 1e-12);
    const v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A log-normal sample for the preset, clamped. */
  delay(preset: DelayPreset): number {
    return clamp(Math.exp(Math.log(preset.median) + preset.sigma * this.normal()), preset.min, preset.max);
  }

  /** A button hold: triangle distribution over [40, 200] ms, peaking near 90 ms. */
  hold(): number {
    const [a, c, b] = [40, 90, 200];
    const u = this.random();
    const f = (c - a) / (b - a);
    return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
  }

  private uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.random();
  }

  private async sleep(ms: number): Promise<void> {
    await this.sleepFn(ms / this.speed);
  }

  /** Wait a think time before an action. */
  async think(): Promise<void> {
    await this.sleep(this.delay(THINK));
  }

  /** A random point inside the box's inner 80%, normally distributed around its centre. */
  targetPoint(box: Box): Point {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    return {
      x: clamp(cx + (this.normal() * box.width) / 6, box.x + box.width * 0.1, box.x + box.width * 0.9),
      y: clamp(cy + (this.normal() * box.height) / 6, box.y + box.height * 0.1, box.y + box.height * 0.9),
    };
  }

  /** Points of a curved, jittered path from `from` to `to`, ending exactly at `to`. */
  path(from: Point, to: Point): Point[] {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const steps = clamp(Math.round(distance / 12), 12, 60);
    // Unit normal to the line; control points sit off it on random sides.
    const nx = distance === 0 ? 0 : -dy / distance;
    const ny = distance === 0 ? 1 : dx / distance;
    const offset = () => (this.random() < 0.5 ? -1 : 1) * this.uniform(0.1, 0.3) * Math.max(distance, 20);
    const o1 = offset();
    const o2 = offset();
    const c1 = { x: from.x + dx / 3 + nx * o1, y: from.y + dy / 3 + ny * o1 };
    const c2 = { x: from.x + (2 * dx) / 3 + nx * o2, y: from.y + (2 * dy) / 3 + ny * o2 };
    const points: Point[] = [];
    for (let i = 1; i <= steps; i++) {
      const t = minimumJerk(i / steps);
      const m = 1 - t;
      const x = m ** 3 * from.x + 3 * m ** 2 * t * c1.x + 3 * m * t ** 2 * c2.x + t ** 3 * to.x;
      const y = m ** 3 * from.y + 3 * m ** 2 * t * c1.y + 3 * m * t ** 2 * c2.y + t ** 3 * to.y;
      points.push(i === steps ? { ...to } : { x: x + this.uniform(-1, 1), y: y + this.uniform(-1, 1) });
    }
    return points;
  }

  private async viewport(): Promise<{ width: number; height: number }> {
    return this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  }

  private async start(): Promise<Point> {
    if (!this.pointer) {
      const { width, height } = await this.viewport();
      this.pointer = { x: this.uniform(0, width), y: this.uniform(0, height) };
    }
    return this.pointer;
  }

  /** Move the pointer along a humanized path, sometimes overshooting and correcting. */
  async moveTo(to: Point): Promise<void> {
    const from = await this.start();
    let points = this.path(from, to);
    if (this.random() < 0.15) {
      const distance = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      const past = this.uniform(3, 8);
      const over = { x: to.x + ((to.x - from.x) / distance) * past, y: to.y + ((to.y - from.y) / distance) * past };
      points = [...this.path(from, over), ...this.path(over, to).slice(-4)];
    }
    for (const p of points) {
      await this.page.mouse.move(p.x, p.y);
      this.pointer = p;
      await this.sleep(this.uniform(4, 12));
    }
    this.pointer = { ...to };
  }

  /** Click like a person; falls back to a plain click when the target has no box. */
  async click(target: HumanTarget, think = true): Promise<void> {
    if (think) await this.think();
    await target.scrollIntoViewIfNeeded();
    // Playwright's own actionability checks and timeouts: visible, enabled, stable, receives events.
    await target.click({ trial: true });
    let box = await boxOf(target);
    if (!box) {
      await target.click();
      return;
    }
    await this.moveTo(this.targetPoint(box));
    await this.sleep(this.uniform(60, 250));
    // The target may have moved during the path; correct with a short final move.
    box = await boxOf(target);
    if (box && !inside(this.pointer!, box)) await this.moveTo(this.targetPoint(box));
    await this.page.mouse.down();
    await this.sleep(this.hold());
    await this.page.mouse.up();
  }

  /** Per-character delays for a value, scaled so a long value takes at most `TYPING_CAP_MS`. */
  keyDelays(value: string): number[] {
    const chars = [...value];
    const delays = chars.map((ch) => this.delay(KEY) + (/[\s.,;:!?]/.test(ch) && this.random() < 0.3 ? this.delay(THINK) : 0));
    const total = delays.reduce((a, b) => a + b, 0);
    if (chars.length > LONG_VALUE && total > TYPING_CAP_MS) return delays.map((d) => (d * TYPING_CAP_MS) / total);
    return delays;
  }

  /** Focus by a humanized click, clear, and type one character at a time. */
  async type(target: HumanTarget, value: string): Promise<void> {
    await this.click(target);
    // Clearing sends a Delete key; skip it on an empty input. Editable non-inputs have no value, so clear them.
    const empty = await target.inputValue().then(
      (v) => v === '',
      () => false,
    );
    if (!empty) await target.fill('');
    const chars = [...value];
    const delays = this.keyDelays(value);
    for (let i = 0; i < chars.length; i++) {
      await this.page.keyboard.type(chars[i]!);
      if (i < chars.length - 1) await this.sleep(delays[i]!);
    }
  }

  async press(key: string, target?: HumanTarget): Promise<void> {
    await this.think();
    if (target) await target.press(key);
    else await this.page.keyboard.press(key);
  }

  /** Focus the `select` by a humanized click, then choose the option; native popups cannot be driven by the mouse. */
  async selectOption(target: HumanTarget, value: string): Promise<void> {
    await this.click(target);
    await target.selectOption({ value });
  }

  /** Wheel down to the bottom in uneven steps; at the step cap, jump like plain mode. */
  async scroll(): Promise<void> {
    await this.think();
    const metrics = () =>
      this.page.evaluate(() => ({ y: window.scrollY, view: window.innerHeight, height: document.documentElement.scrollHeight }));
    let m = await metrics();
    const cap = Math.max(20, Math.ceil(m.height / 200));
    await this.moveTo(await this.restingPoint());
    for (let i = 0; i < cap; i++) {
      if (m.y + m.view >= m.height - 2) return;
      await this.page.mouse.wheel(0, this.delay(WHEEL));
      await this.sleep(this.random() < 0.1 ? this.uniform(600, 1500) : this.uniform(80, 400));
      m = await metrics();
    }
    if (m.y + m.view < m.height - 2) await this.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  }

  private async restingPoint(): Promise<Point> {
    const { width, height } = await this.viewport();
    return { x: this.uniform(width * 0.3, width * 0.7), y: this.uniform(height * 0.3, height * 0.7) };
  }

  /** Linger on a loaded page with small pointer moves and sometimes a small scroll and back. */
  async dwell(): Promise<void> {
    const total = this.delay(DWELL);
    const moves = 1 + Math.floor(this.random() * 3);
    const { width, height } = await this.viewport();
    for (let i = 0; i < moves; i++) {
      const from = await this.start();
      const angle = this.uniform(0, 2 * Math.PI);
      const length = this.uniform(20, 200);
      await this.moveTo({
        x: clamp(from.x + Math.cos(angle) * length, 1, Math.max(1, width - 1)),
        y: clamp(from.y + Math.sin(angle) * length, 1, Math.max(1, height - 1)),
      });
      await this.sleep(total / (moves + 1));
    }
    if (this.random() < 0.5) {
      const dy = this.uniform(60, 240);
      await this.page.mouse.wheel(0, dy);
      await this.sleep(this.uniform(200, 600));
      await this.page.mouse.wheel(0, -dy);
    }
    await this.sleep(total / (moves + 1));
  }
}

function inside(p: Point, box: Box): boolean {
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}
