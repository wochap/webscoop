import type { ElementRef, Session } from '../ports';
import type { Recipe } from '../recipe/schema';
import { fillTemplate, templateVariables } from '../template';
import { PaginationInputError, type Advance, type PageStrategy, type PagerContext } from './types';

/** Whether a next or load-more control is disabled: `disabled`, `aria-disabled="true"`, or an anchor without `href`. */
export async function isDisabled(session: Session, ref: ElementRef): Promise<boolean> {
  const node = await session.snapshot(ref);
  if (node.type !== 'element') return false;
  const { attrs, tag } = node;
  return 'disabled' in attrs || attrs['aria-disabled'] === 'true' || (tag === 'a' && !('href' in attrs));
}

/** Poll the item count until it exceeds `before` or the timeout passes. */
async function waitForGrowth(ctx: PagerContext, before: number): Promise<boolean> {
  const deadline = Date.now() + ctx.timeoutMs;
  for (;;) {
    if ((await ctx.count()) > before) return true;
    if (Date.now() >= deadline) return false;
    await ctx.sleep(ctx.pollMs ?? 200);
  }
}

/** The target, or null when it is missing or disabled. */
async function usableTarget(ctx: PagerContext): Promise<ElementRef | null> {
  const ref = await ctx.target();
  if (!ref || (await isDisabled(ctx.session, ref))) return null;
  return ref;
}

const TARGET_MISSING: Advance = { kind: 'stop', reason: 'target-missing' };

/** The page variable's first value: the user's `--var` when given, else `param.start`. */
function startValue(recipe: Recipe, vars: Readonly<Record<string, string>>): number {
  const param = recipe.pagination.param!;
  const given = vars[param.name];
  if (given === undefined) return param.start;
  if (!/^-?\d+$/.test(given.trim())) {
    throw new PaginationInputError(`page variable ${param.name} must be an integer, got "${given}"`, [param.name]);
  }
  return Number(given);
}

/** Build the strategy for the recipe's pagination kind. Throws when variables are missing or invalid. */
export function createStrategy(recipe: Recipe, vars: Readonly<Record<string, string>> = {}): PageStrategy {
  const { kind } = recipe.pagination;
  const goto = (ctx: PagerContext, url: string) => ctx.session.goto(url, { timeoutMs: ctx.timeoutMs });

  if (kind === 'url') {
    const param = recipe.pagination.param;
    if (!param) throw new PaginationInputError('pagination kind url needs pagination.param');
    const start = startValue(recipe, vars);
    // A template without the page variable (as the recorder saves it) gets it as a query parameter.
    const inTemplate = templateVariables(recipe.url).includes(param.name);
    const urlFor = (page: number) => {
      const value = String(start + param.step * (page - 1));
      const filled = fillTemplate(recipe.url, recipe.vars, { ...vars, [param.name]: value });
      if (inTemplate) return filled;
      const url = new URL(filled);
      url.searchParams.set(param.name, value);
      return url.href;
    };
    const url = urlFor(1);
    return {
      kind,
      url,
      first: (ctx) => goto(ctx, url),
      async next(ctx, page) {
        const next = urlFor(page + 1);
        ctx.advancing();
        return { kind: 'page', info: await goto(ctx, next) };
      },
    };
  }

  const url = fillTemplate(recipe.url, recipe.vars, vars);
  const first = (ctx: PagerContext) => goto(ctx, url);
  switch (kind) {
    case 'none':
      return { kind, url, first, next: async () => ({ kind: 'stop', reason: 'none' }) };
    case 'next':
      return {
        kind,
        url,
        first,
        async next(ctx) {
          const ref = await usableTarget(ctx);
          if (!ref) return TARGET_MISSING;
          const previousUrl = await ctx.session.url();
          ctx.advancing();
          await ctx.session.click(ref);
          return { kind: 'page', info: await ctx.session.settle({ timeoutMs: ctx.timeoutMs, previousUrl }) };
        },
      };
    case 'more':
      return {
        kind,
        url,
        first,
        async next(ctx) {
          const ref = await usableTarget(ctx);
          if (!ref) return TARGET_MISSING;
          const before = await ctx.count();
          ctx.advancing();
          await ctx.session.click(ref);
          return (await waitForGrowth(ctx, before)) ? { kind: 'grown', from: before } : { kind: 'stop', reason: 'no-growth' };
        },
      };
    case 'scroll':
      return {
        kind,
        url,
        first,
        async next(ctx) {
          const before = await ctx.count();
          ctx.advancing();
          await ctx.session.scrollToBottom();
          return (await waitForGrowth(ctx, before)) ? { kind: 'grown', from: before } : { kind: 'stop', reason: 'no-growth' };
        },
      };
  }
}

/** URL of a recipe's first page with the given variables, the page variable included. */
export function firstPageUrl(recipe: Recipe, vars: Readonly<Record<string, string>> = {}): string {
  return createStrategy(recipe, vars).url;
}
