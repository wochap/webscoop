import type { PageExtraction } from '../extract';
import { resolveFirst } from '../extract';
import type { PageInfo, SerializedNode, Session } from '../ports';
import type { GuardKind, Recipe } from '../recipe/schema';

/** Path segments that mark a login page: `/login`, `/signin`, `/sign-in`, `/account/login`, `/auth`, `/sso`. */
export const LOGIN_URL_PATTERN = /(?:^|\/)(?:login|signin|sign-in|auth|sso)(?:\/|$)/i;

/** Substrings of a frame's or element's `src`, `id`, or class that mark a bot challenge. */
export const CAPTCHA_MARKERS = ['turnstile', 'recaptcha', 'hcaptcha', 'challenge', 'cf-chl', 'arkose'] as const;

/** Words in the visible text of a 403 or 429 page that mark it as a challenge. */
export const CHALLENGE_WORDS = ['verify', 'robot', 'human', 'challenge'] as const;

/** Visible text shorter than this, on a page where nothing resolved, points at an interstitial. */
export const SHORT_PAGE_CHARS = 500;

/** Order in which matching guards are reported. */
export const GUARD_ORDER: readonly GuardKind[] = ['captcha', 'login', 'zero-fields'];

export type GuardPhase = 'load' | 'extract';

export interface GuardContext {
  session: Session;
  recipe: Recipe;
  info: PageInfo;
  /** URL the runner meant to load for this page. */
  intendedUrl: string;
  /** The page's extraction, for the extract phase. */
  extraction?: PageExtraction;
  /** Whether this is a later page, where an empty list is the end of the list rather than a failure. */
  laterPage?: boolean;
  /** Lazily taken, shared by the detectors of one evaluation. */
  snapshot(): Promise<SerializedNode>;
  /** Lazily read, shared by the detectors of one evaluation. */
  text(): Promise<string>;
}

export interface GuardMatch {
  kind: GuardKind;
  /** One line for logs, the notification, and the banner. */
  reason: string;
}

export interface GuardDetector {
  kind: GuardKind;
  phase: GuardPhase;
  matches(ctx: GuardContext): Promise<GuardMatch | null>;
}

/** A context whose snapshot and text are read at most once. */
export function guardContext(opts: Omit<GuardContext, 'snapshot' | 'text'>): GuardContext {
  let snapshot: Promise<SerializedNode> | undefined;
  let text: Promise<string> | undefined;
  return {
    ...opts,
    snapshot: () => (snapshot ??= opts.session.snapshot()),
    text: () => (text ??= opts.session.pageText()),
  };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function walk(node: SerializedNode, visit: (el: Extract<SerializedNode, { type: 'element' }>) => boolean): boolean {
  if (node.type !== 'element') return false;
  if (visit(node)) return true;
  return node.children.some((child) => walk(child, visit));
}

/** Whether the snapshot measured the element as taking no space; unmeasured elements count as visible. */
function hidden(el: Extract<SerializedNode, { type: 'element' }>): boolean {
  return (el.bbox !== undefined && (el.bbox.w === 0 || el.bbox.h === 0)) || 'hidden' in el.attrs || el.attrs.type === 'hidden';
}

/** Whether the item container (or, without one, any field) resolves with its stored selectors. */
async function itemsPresent(ctx: GuardContext): Promise<boolean> {
  const { recipe, session } = ctx;
  if (recipe.item) return (await resolveFirst(session, recipe.item.selectors)) !== null;
  for (const field of recipe.fields) {
    if ((await resolveFirst(session, field.selectors)) !== null) return true;
  }
  return false;
}

export const loginDetector: GuardDetector = {
  kind: 'login',
  phase: 'load',
  async matches(ctx) {
    const landed = pathOf(ctx.info.url);
    if (LOGIN_URL_PATTERN.test(landed) && !LOGIN_URL_PATTERN.test(pathOf(ctx.intendedUrl))) {
      return { kind: 'login', reason: `redirected to a login page (${landed})` };
    }
    const password = walk(await ctx.snapshot(), (el) => el.tag === 'input' && (el.attrs.type ?? '').toLowerCase() === 'password' && !hidden(el));
    if (password && !(await itemsPresent(ctx))) return { kind: 'login', reason: 'the page asks for a password and shows no items' };
    return null;
  },
};

export const captchaDetector: GuardDetector = {
  kind: 'captcha',
  phase: 'load',
  async matches(ctx) {
    let marker: string | undefined;
    walk(await ctx.snapshot(), (el) => {
      const haystack = [el.attrs.src, el.attrs.id, el.attrs.class].filter(Boolean).join(' ').toLowerCase();
      marker = CAPTCHA_MARKERS.find((m) => haystack.includes(m));
      return marker !== undefined;
    });
    if (marker) return { kind: 'captcha', reason: `the page shows a bot challenge (${marker})` };
    const status = ctx.info.status;
    if (status === 403 || status === 429) {
      const text = (await ctx.text()).toLowerCase();
      const word = CHALLENGE_WORDS.find((w) => text.includes(w));
      if (word) return { kind: 'captcha', reason: `HTTP ${status} page asking to "${word}"` };
    }
    return null;
  },
};

/** Whether the item container and every required field resolved nothing. */
export function nothingResolved(recipe: Recipe, extraction: PageExtraction): boolean {
  const required = extraction.fields.filter((f) => !f.optional);
  if (!recipe.item && required.length === 0) return false;
  const noItems = !recipe.item || !extraction.item || extraction.item.count === 0;
  return noItems && required.every((f) => f.status === 'missing');
}

export const zeroFieldsDetector: GuardDetector = {
  kind: 'zero-fields',
  phase: 'extract',
  async matches(ctx) {
    if (!ctx.extraction || !nothingResolved(ctx.recipe, ctx.extraction)) return null;
    const status = ctx.info.status;
    if (status !== null && status >= 400) return { kind: 'zero-fields', reason: `nothing resolved on an HTTP ${status} page` };
    // An empty later page is the end of the list; only an errored one is a wall.
    if (ctx.laterPage) return null;
    const length = (await ctx.text()).length;
    if (length < SHORT_PAGE_CHARS) return { kind: 'zero-fields', reason: `nothing resolved on a short page (${length} characters)` };
    return null;
  },
};

export const DETECTORS: readonly GuardDetector[] = [captchaDetector, loginDetector, zeroFieldsDetector];

/** Detectors the recipe enables (all by default), in report order; none when the run disables guards. */
export function enabledDetectors(recipe: Recipe, runEnabled = true): GuardDetector[] {
  if (!runEnabled) return [];
  const off = new Set(recipe.guards.filter((g) => !g.enabled).map((g) => g.kind));
  return GUARD_ORDER.map((kind) => DETECTORS.find((d) => d.kind === kind)!).filter((d) => !off.has(d.kind));
}

/** First match among the detectors of one phase, in report order. */
export async function detect(detectors: readonly GuardDetector[], phase: GuardPhase, ctx: GuardContext): Promise<GuardMatch | null> {
  for (const detector of detectors) {
    if (detector.phase !== phase) continue;
    const match = await detector.matches(ctx);
    if (match) return match;
  }
  return null;
}
