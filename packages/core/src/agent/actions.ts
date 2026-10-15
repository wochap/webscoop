import { z } from 'zod';
import type { RunWindows } from '../flows/windows';
import { FillUnresolvedError, TimeoutError, type ElementRef, type PageInfo, type SavedDownload, type Session } from '../ports';
import type { AnnotatedNode } from '../selectors/annotated';
import { refForNode } from '../selectors/xpath';
import type { Outline } from './outline';

/** Longest outer HTML the `html` action answers with. */
export const HTML_MAX = 2000;
/** Longest `wait` action. */
export const WAIT_MAX_MS = 5000;

export const ACTION_NAMES = ['click', 'fill', 'press', 'scroll', 'find', 'html', 'wait', 'done', 'give_up'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

const reason = z.string().default('');
const ref = z.string().transform((s) => s.replace(/[[\]\s]/g, '')).pipe(z.string().regex(/^e\d+$/, 'expected a ref such as "e3"'));
const text = z.union([z.string(), z.number()]).transform(String);

const VARIANTS = {
  click: z.object({ action: z.literal('click'), ref, reason }),
  fill: z.object({ action: z.literal('fill'), ref, value: text, reason }),
  press: z.object({ action: z.literal('press'), key: z.string().min(1), ref: ref.optional(), reason }),
  scroll: z.object({ action: z.literal('scroll'), direction: z.enum(['down', 'up', 'bottom'], { error: 'direction is down, up, or bottom' }), reason }),
  find: z.object({ action: z.literal('find'), text: z.string().min(1), reason }),
  html: z.object({ action: z.literal('html'), ref, reason }),
  wait: z.object({ action: z.literal('wait'), ms: z.number().int().min(1).max(WAIT_MAX_MS), reason }),
  done: z.object({ action: z.literal('done'), reason }),
  give_up: z.object({ action: z.literal('give_up'), reason }),
} as const;

/** Any answer that is JSON: the loop validates the action itself, so a bad one gets a useful result. */
export const AnswerSchema = z.record(z.string(), z.unknown());

export type AgentAction = { [K in ActionName]: z.output<(typeof VARIANTS)[K]> }[ActionName];

export type ParsedAction = { ok: true; action: AgentAction } | { ok: false; problem: string };

/** The valid actions, one per line with their arguments, for the system message and for invalid-answer results. */
export const ACTION_HELP = [
  '{"action":"click","ref":"e3","reason":"..."}  click an element',
  '{"action":"fill","ref":"e4","value":"text","reason":"..."}  type into a field, choose an option, or set a checkbox (true or false)',
  '{"action":"press","key":"Enter","ref":"e4","reason":"..."}  press a key (ref optional)',
  '{"action":"scroll","direction":"down","reason":"..."}  scroll down, up, or to the bottom',
  '{"action":"find","text":"pdf","reason":"..."}  list outline lines containing the text, also lines cut from the outline',
  '{"action":"html","ref":"e3","reason":"..."}  show the HTML of an element',
  '{"action":"wait","ms":1000,"reason":"..."}  wait 1 to 5000 ms',
  '{"action":"done","reason":"..."}  the goal is reached',
  '{"action":"give_up","reason":"..."}  the goal cannot be reached',
].join('\n');

/** Check a model answer against the action schema; the problem names what is wrong. */
export function parseAction(raw: unknown): ParsedAction {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'the answer is not a JSON object' };
  const name = (raw as { action?: unknown }).action;
  if (typeof name !== 'string') return { ok: false, problem: 'the answer has no "action"' };
  if (!(ACTION_NAMES as readonly string[]).includes(name)) return { ok: false, problem: `the action ${JSON.stringify(name)} is unknown` };
  const parsed = VARIANTS[name as ActionName].safeParse(raw);
  if (parsed.success) return { ok: true, action: parsed.data as AgentAction };
  const issue = parsed.error.issues[0]!;
  const field = issue.path.length > 0 ? issue.path.join('.') : 'answer';
  return { ok: false, problem: `${name}: ${field}: ${issue.message}` };
}

/** The result for an answer that did not fit the schema: what is wrong, and the valid actions. */
export function invalidAnswerResult(problem: string): string {
  return `Invalid answer: ${problem}. Answer with exactly one JSON object, one of:\n${ACTION_HELP}`;
}

/** What an executed action reports back. */
export interface ActionResult {
  /** What happened, for the model. */
  text: string;
  /** The loop's end condition held during the action; nothing else was done after it. */
  stopped?: boolean;
}

export interface ActionContext {
  /** The step's window. */
  session: Session;
  windows: RunWindows;
  timeoutMs: number;
  /** The document the step started on; actions that leave it are undone. */
  startUrl: string;
  sleep: (ms: number) => Promise<void>;
  /** Called with the settled page when an action navigated the step's window (the main window only), for guards. Returns the page to go on with. */
  onNavigated?: (info: PageInfo) => Promise<PageInfo>;
  /** Whether the loop's end condition (a saved download) already holds. */
  stop: () => boolean;
}

const stripFragment = (url: string) => url.replace(/#.*$/, '');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Outer HTML of a snapshot node. */
export function outerHtml(node: AnnotatedNode): string {
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v.replace(/"/g, '&quot;')}"`))
    .join('');
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  const inner = node.children.map((c) => (c.type === 'text' ? c.text.replace(/</g, '&lt;') : outerHtml(c))).join('');
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

const firstLine = (text: string) => text.split('\n', 1)[0]!;

/** Executes actions in the step's window and says what came of them. */
export class AgentActions {
  private previous: string | null = null;

  constructor(private readonly ctx: ActionContext) {}

  async run(action: AgentAction, outline: Outline): Promise<ActionResult> {
    switch (action.action) {
      case 'find': {
        const lines = outline.find(action.text);
        return { text: lines.length > 0 ? `${lines.length} line${lines.length === 1 ? '' : 's'} contain ${JSON.stringify(action.text)}:\n${lines.join('\n')}` : `no line contains ${JSON.stringify(action.text)}` };
      }
      case 'html': {
        const node = outline.node(action.ref);
        if (!node) return { text: staleRef(action.ref) };
        const html = outerHtml(node);
        return { text: html.length > HTML_MAX ? `${html.slice(0, HTML_MAX)}… (cut at ${HTML_MAX} characters)` : html };
      }
      case 'wait':
        await this.ctx.sleep(action.ms);
        return { text: `waited ${action.ms} ms` };
      case 'click':
      case 'fill':
      case 'press':
      case 'scroll':
        return this.act(action, outline);
      case 'done':
      case 'give_up':
        return { text: '' };
    }
  }

  private async act(action: Extract<AgentAction, { action: 'click' | 'fill' | 'press' | 'scroll' }>, outline: Outline): Promise<ActionResult> {
    const { session, windows } = this.ctx;
    const key = JSON.stringify({ ...action, reason: undefined });
    const repeated = key === this.previous;
    this.previous = key;
    const refName = action.action === 'scroll' ? undefined : action.ref;
    let target: ElementRef | undefined;
    if (refName !== undefined) {
      const node = outline.node(refName);
      if (!node) return { text: staleRef(refName) };
      const found = await refForNode(session, node).catch(() => null);
      if (!found) return { text: staleRef(refName) };
      target = found;
    }

    const parts: string[] = [];
    if (repeated) parts.push('You already did exactly this on the previous turn; the page may not have changed. Try something else.');
    const before = stripFragment(await session.url());
    const previousUrl = await session.url();
    const mark = windows.mark();
    const saved: SavedDownload[] = [];
    const off = session.onDownload((d) => saved.push(d));
    let settled: PageInfo | null = null;
    try {
      try {
        switch (action.action) {
          case 'click':
            await session.click(target!);
            parts.push(`Clicked ${refName}.`);
            break;
          case 'fill':
            await session.fill(target!, action.value, { timeoutMs: this.ctx.timeoutMs });
            parts.push(`Filled ${refName}.`);
            break;
          case 'press':
            await session.press(action.key, target);
            parts.push(`Pressed ${action.key}${refName ? ` on ${refName}` : ''}.`);
            break;
          case 'scroll':
            if (action.direction === 'bottom') await session.scrollToBottom();
            else await session.scrollBy(action.direction);
            parts.push(`Scrolled ${action.direction}.`);
            break;
        }
      } catch (error) {
        const message = firstLine(error instanceof Error ? error.message : String(error));
        return { text: `${error instanceof FillUnresolvedError ? 'Found no matching option' : 'The action failed'}: ${message}` };
      }
      if (!session.isClosed()) {
        settled = await session.settle({ timeoutMs: this.ctx.timeoutMs, previousUrl }).catch((error: unknown) => {
          if (error instanceof TimeoutError) {
            parts.push('The page was still loading after the wait.');
            return null;
          }
          if (session.isClosed()) return null;
          throw error;
        });
      }
      await session.settleDownloads(this.ctx.timeoutMs).catch(() => {});
    } finally {
      off();
    }
    if (this.ctx.stop()) return { text: '', stopped: true };

    let changes = 0;
    for (const d of saved) {
      parts.push(`A download was saved as ${d.name}.`);
      changes++;
    }
    // Popups: documents are out of scope; one that only started a download is left to close itself.
    for (const popup of windows.openPopupsSince(mark)) {
      const fromPopup = saved.some((d) => d.origin === popup);
      if (fromPopup) continue;
      const at = await popup.url().catch(() => '');
      await popup.close().catch(() => {});
      parts.push(`It opened a popup${at && at !== 'about:blank' ? ` at ${at}` : ''}, which is outside this step's scope; the popup was closed.`);
      changes++;
    }

    if (session.isClosed()) {
      parts.push('The window closed.');
      return { text: parts.join(' ') };
    }
    let info = settled;
    const now = await session.url().catch(() => before);
    const left = stripFragment(now) !== stripFragment(this.ctx.startUrl);
    if (left && !settled?.download) {
      parts.push(`That navigated to ${now}, which is outside this step's scope; the page was restored.`);
      info = await this.restore();
      changes++;
    } else if (now !== previousUrl) {
      changes++;
      parts.push(`The page URL is now ${now}${settled?.title ? ` (title ${JSON.stringify(settled.title)})` : ''}.`);
    }
    if (info && this.ctx.onNavigated && (left || info.url !== previousUrl) && !info.download) {
      await this.ctx.onNavigated(info);
    }
    if (changes === 0) parts.push('The URL did not change; see the outline for what the page shows now.');
    return { text: parts.join(' ') };
  }

  /** Back to the document the step started on. */
  private async restore(): Promise<PageInfo | null> {
    try {
      const info = await this.ctx.session.goto(this.ctx.startUrl, { timeoutMs: this.ctx.timeoutMs });
      return info.download ? null : info;
    } catch {
      return null;
    }
  }
}

const staleRef = (ref: string) => `The ref ${ref} is stale or unknown: it is not in the current outline. Use a ref from the outline below.`;
