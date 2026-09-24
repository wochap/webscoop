import { z } from 'zod';
import { convertValue, parseDate } from '../convert';
import { completeJson } from '../llm/json';
import type { ChatMessage, LlmPort } from '../ports';
import type { Fingerprint } from '../recipe/schema';
import { ancestorsOf, descendantsOf, type AnnotatedNode } from '../selectors/annotated';
import { normalize, textContent } from '../selectors/aria';
import { classifyToken } from '../selectors/tokens';
import { refForNode, xpathFor } from '../selectors/xpath';
import { scoreFingerprint } from './score';
import { targetName, type HealContext, type HealTarget, type Resolution, type Resolver } from './types';

/** Most candidates a prompt lists. */
export const MAX_CANDIDATES = 60;
/** Share of the context window a prompt may fill. */
export const PROMPT_BUDGET = 0.4;
/** Every prompt line, candidate lines included, is shorter than this. */
export const MAX_LINE = 160;
/** Own text of a candidate is cut to this many characters. */
export const MAX_OWN_TEXT = 80;
/** Ancestor tokens shown per candidate. */
export const CANDIDATE_ANCESTORS = 4;
/** Picks below this confidence are ignored. */
export const MIN_CONFIDENCE = 0.5;
/** A field pick whose fingerprint score is below this is rejected. */
export const MIN_PICK_SCORE = 0.4;

/** The model's answer. */
export const PickSchema = z.object({
  index: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type ModelPick = z.infer<typeof PickSchema>;

export interface ModelCandidate {
  node: AnnotatedNode;
  /** Fingerprint score, when the target has a fingerprint. */
  score: number | null;
}

/** Elements that never render content. */
const INVISIBLE = new Set(['head', 'script', 'style', 'noscript', 'template', 'meta', 'link', 'title', 'base']);

function selfHidden(node: AnnotatedNode): boolean {
  if (INVISIBLE.has(node.tag)) return true;
  if ('hidden' in node.attrs || node.attrs['aria-hidden'] === 'true') return true;
  return !!node.bbox && node.bbox.w === 0 && node.bbox.h === 0;
}

/** Hidden itself or inside a hidden element of the snapshot; the document element and body are never candidates. */
function hidden(node: AnnotatedNode): boolean {
  return node.tag === 'html' || node.tag === 'body' || selfHidden(node) || ancestorsOf(node).some(selfHidden);
}

/** Text of the element's own text nodes, not its children's, whitespace collapsed. */
export function directText(node: AnnotatedNode): string {
  return normalize(node.children.map((c) => (c.type === 'text' ? c.text : ' ')).join(''));
}

const hasBackgroundImage = (node: AnnotatedNode) =>
  /url\(/i.test(node.attrs.style ?? '') || ['data-bg', 'data-background', 'data-background-image'].some((a) => a in node.attrs);

/** Whether an element can hold the target's value, by field type. */
export function plausible(node: AnnotatedNode, target: HealTarget): boolean {
  switch (target.kind) {
    case 'item':
      return node.children.some((c) => c.type === 'element') && normalize(textContent(node)) !== '';
    case 'pagination':
      return node.tag === 'a' || node.tag === 'button' || node.role === 'link' || node.role === 'button';
    case 'field':
      if (target.attr) return target.attr in node.attrs;
      switch (target.type ?? 'text') {
        case 'text':
        case 'number':
          return directText(node) !== '';
        case 'url':
          return node.tag === 'a';
        case 'image':
          return node.tag === 'img' || hasBackgroundImage(node);
        case 'date':
          return directText(node) !== '' || 'datetime' in node.attrs;
        case 'html':
          return true;
      }
  }
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);
const quote = (text: string) => text.replace(/"/g, "'");

/** Up to `max` attributes a model can read meaning from, in a fixed order. */
function keyAttrs(node: AnnotatedNode, max = 3): [string, string][] {
  const names = Object.keys(node.attrs);
  const readable = (v: string) => classifyToken(v) !== 'hashed';
  const out: [string, string][] = [];
  if (node.attrs.id && readable(node.attrs.id)) out.push(['id', node.attrs.id]);
  for (const name of names.filter((n) => n.startsWith('data-')).sort()) if (readable(node.attrs[name]!)) out.push([name, node.attrs[name]!]);
  for (const name of ['aria-label', 'title', 'alt']) if (node.attrs[name]) out.push([name, node.attrs[name]!]);
  if (node.attrs.href) out.push(['href', node.attrs.href.replace(/\d/g, '#')]);
  return out.slice(0, max);
}

/**
 * One line describing a candidate: tag, role, up to three key attributes,
 * its own text cut to 80 characters, and the nearest four ancestors (outer
 * first). Values are shortened until the line fits in `max` characters.
 * With `text: 'content'` the whole text content stands in for the own text,
 * for containers whose text all sits in their children.
 */
export function serializeCandidate(node: AnnotatedNode, max = MAX_LINE - 5, opts: { text?: 'own' | 'content' } = {}): string {
  const role = node.role && node.role !== node.tag ? ` role="${quote(clip(node.role, 20))}"` : '';
  const path = ancestorsOf(node)
    .slice(0, CANDIDATE_ANCESTORS)
    .map((a) => a.role ?? a.tag)
    .reverse()
    .join('>');
  const attrs = keyAttrs(node);
  const own = opts.text === 'content' ? normalize(textContent(node)) : directText(node);
  const build = (attrCap: number, attrCount: number, textCap: number) => {
    const attrText = attrs
      .slice(0, attrCount)
      .map(([k, v]) => ` ${clip(k, 24)}="${quote(clip(v, attrCap))}"`)
      .join('');
    const text = own ? ` "${quote(clip(own, textCap))}"` : '';
    return `<${clip(node.tag, 16)}${role}${attrText}>${text}${path ? ` @ ${path}` : ''}`;
  };
  for (const [attrCap, attrCount, textCap] of [
    [40, 3, MAX_OWN_TEXT],
    [24, 3, MAX_OWN_TEXT],
    [24, 2, MAX_OWN_TEXT],
    [16, 1, MAX_OWN_TEXT],
    [16, 1, 40],
    [16, 0, 40],
  ] as const) {
    const line = build(attrCap, attrCount, textCap);
    if (line.length <= max) return line;
  }
  return clip(build(16, 0, 40), max);
}

/** The line for the candidate at `position` (0-based); lines are numbered from 1, and item containers show their whole text. */
export const candidateLine = (position: number, node: AnnotatedNode, target?: HealTarget) => {
  const prefix = `#${position + 1} `;
  return prefix + serializeCandidate(node, MAX_LINE - 1 - prefix.length, { text: target?.kind === 'item' ? 'content' : 'own' });
};

const SYSTEM_PROMPT = [
  'You locate one element of a web page in a numbered list of candidates.',
  'Reply with JSON only: {"index": <candidate number or null>, "confidence": <0 to 1>, "reason": "<short reason>"}.',
  'Candidates are numbered from 1; index is the number after #.',
  'Use null when no candidate is the field. Never pick an element that holds a different kind of value.',
].join('\n');

function describeTarget(target: HealTarget): string[] {
  switch (target.kind) {
    case 'item':
      return ['Field: item', 'Type: container of one repeated result (a card, row, or list entry)'];
    case 'pagination':
      return ['Field: pagination', 'Type: link or button to the next page'];
    case 'field':
      return [`Field: ${target.name}`, `Type: ${target.type ?? 'text'}${target.attr ? ` read from attribute ${target.attr}` : ''}`];
  }
}

function describeFingerprint(fp: Fingerprint | undefined): string[] {
  if (!fp) return ['Recorded element: unknown'];
  const line = (key: string, value: string | undefined) => (value ? [clip(`  ${key}: ${value.replace(/\s+/g, ' ')}`, MAX_LINE - 1)] : []);
  const attrs = Object.entries(fp.attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return [
    'Recorded element:',
    ...line('tag', fp.tag),
    ...line('role', fp.role),
    ...line('name', fp.name),
    ...line('text', fp.textSample),
    ...line('attributes', attrs),
    ...line('ancestors', [...fp.ancestors].reverse().join('>')),
  ];
}

/**
 * The chat messages asking for a pick: the task and answer contract, then the
 * field, its recorded fingerprint, the last known value, and the numbered
 * candidates. Deterministic for the same inputs; every line under 160
 * characters.
 */
export function buildPrompt(
  target: HealTarget,
  fingerprint: Fingerprint | undefined,
  sample: string | null,
  candidates: readonly AnnotatedNode[],
): ChatMessage[] {
  const user = [
    ...describeTarget(target),
    ...describeFingerprint(fingerprint),
    ...(sample ? [clip(`Last value: ${sample.replace(/\s+/g, ' ')}`, MAX_LINE - 1)] : []),
    'Candidates (#index <tag attributes> "own text" @ ancestors):',
    ...candidates.map((node, i) => candidateLine(i, node, target)),
  ];
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user.join('\n') },
  ];
}

/** The last known value of a target: its fingerprint's text sample. */
export const sampleOf = (target: HealTarget): string | null => target.fingerprint?.textSample || null;

/** Estimated size of a prompt: every message's content. */
export function promptTokens(llm: Pick<LlmPort, 'estimateTokens'>, messages: readonly ChatMessage[]): number {
  return llm.estimateTokens(messages.map((m) => m.content).join('\n'));
}

/**
 * Elements of the scope that could be the target, best first: plausible for
 * the field type, not hidden, not the scope root, ranked by fingerprint score
 * (document order without a fingerprint), at most 60, and no more than fit
 * with the rest of the prompt in 40 percent of the context window.
 */
export function pruneCandidates(
  root: AnnotatedNode,
  target: HealTarget,
  ctx: Pick<HealContext, 'outerAncestors' | 'viewport'>,
  llm: Pick<LlmPort, 'estimateTokens' | 'contextTokens'>,
): ModelCandidate[] {
  const fp = target.fingerprint;
  const opts = { outerAncestors: ctx.outerAncestors, ...(ctx.viewport ? { viewport: ctx.viewport } : {}) };
  const pool = descendantsOf(root)
    .filter((n) => n !== root && !hidden(n) && plausible(n, target))
    .map((node, order) => ({ node, order, score: fp ? scoreFingerprint(fp, node, opts) : null }));
  if (fp) pool.sort((a, b) => b.score! - a.score! || a.order - b.order);

  const budget = Math.floor(PROMPT_BUDGET * llm.contextTokens);
  let used = promptTokens(llm, buildPrompt(target, fp, sampleOf(target), []));
  const out: ModelCandidate[] = [];
  for (const { node, score } of pool) {
    if (out.length >= MAX_CANDIDATES) break;
    const cost = llm.estimateTokens(`${candidateLine(out.length, node, target)}\n`);
    if (used + cost > budget) break;
    used += cost;
    out.push({ node, score });
  }
  return out;
}

/** Adapter failures that mean the endpoint itself is unusable, as opposed to one bad answer. */
const TRANSPORT_FAILURES = new Set(['unavailable', 'network', 'timeout', 'http', 'invalid-response']);

/** Raw string the runner would read for a field from a snapshot node. */
function rawValue(target: Extract<HealTarget, { kind: 'field' }>, node: AnnotatedNode): string {
  return target.attr ? (node.attrs[target.attr] ?? '') : textContent(node);
}

/** Why a pick fails the type check, or null when it passes. */
function typeCheck(target: HealTarget, node: AnnotatedNode): string | null {
  if (target.kind !== 'field') return null;
  if (target.type === 'number' && convertValue('number', rawValue(target, node), 'http://localhost/') === null) return 'its text has no number';
  if (target.type === 'date') {
    const raw = rawValue(target, node);
    if (parseDate(raw) === null && !(node.attrs.datetime && parseDate(node.attrs.datetime) !== null)) return 'its text is not a date';
  }
  return null;
}

export interface ModelResolverOptions {
  /** False with `--no-llm`. */
  enabled: boolean;
  /** One line for the user when the adapter fails and the rung turns itself off. */
  log?: (message: string) => void;
  /** Answer token cap. Default 200. */
  maxTokens?: number;
}

/**
 * Rung 3: ask a language model to pick the target from a pruned list of the
 * scope's elements, then verify the pick (confidence, fingerprint score,
 * type) before accepting it. The first adapter failure turns the rung off
 * for the rest of the run. Skipped when the recipe sets `healing.llm` false.
 */
export function modelResolver(llm: LlmPort, opts: ModelResolverOptions): Resolver {
  let failed = false;
  return {
    name: 'model',
    recipeGated: true,
    async resolve(target, ctx): Promise<Resolution | null> {
      if (!opts.enabled || !llm.available || failed) return null;
      const note = (text: string) => ctx.note?.(target, `model: ${text}`);
      const within = ctx.probe ? ((await ctx.probe()) ?? ctx.within) : ctx.within;
      const root = await ctx.snapshotOf(within);
      const candidates = pruneCandidates(root, target, ctx, llm);
      if (candidates.length === 0) {
        note('no candidate elements in scope');
        return null;
      }
      const messages = buildPrompt(target, target.fingerprint, sampleOf(target), candidates.map((c) => c.node));
      const answer = await completeJson(llm, messages, PickSchema, { maxTokens: opts.maxTokens ?? 200, noThinking: true });
      if (!answer.ok) {
        if (TRANSPORT_FAILURES.has(answer.error.kind)) {
          failed = true;
          opts.log?.(`language model failed on ${targetName(target)}, skipping the model for the rest of this run: ${answer.error.message}`);
        }
        note(`no usable answer (${answer.error.message})`);
        return null;
      }
      const { index, confidence, reason } = answer.value;
      if (index === null) {
        note(`no pick (${reason})`);
        return null;
      }
      const picked = index >= 1 ? candidates[index - 1] : undefined;
      if (!picked) {
        note(`picked #${index}, outside candidates #1 to #${candidates.length}`);
        return null;
      }
      if (confidence < MIN_CONFIDENCE) {
        note(`picked #${index} with confidence ${confidence} below ${MIN_CONFIDENCE} (${reason})`);
        return null;
      }
      // An item container's text is every field of one item, so its score says
      // little about whether it is a container; promotion checks that instead.
      if (target.kind !== 'item' && picked.score !== null && picked.score < MIN_PICK_SCORE) {
        note(`picked #${index} with fingerprint score ${picked.score.toFixed(2)} below ${MIN_PICK_SCORE} (${reason})`);
        return null;
      }
      const mismatch = typeCheck(target, picked.node);
      if (mismatch) {
        note(`picked #${index} but ${mismatch} (${reason})`);
        return null;
      }
      const ref = await refForNode(ctx.session, picked.node, within);
      if (!ref) {
        note(`picked #${index} but its position no longer resolves`);
        return null;
      }
      return {
        refs: [ref],
        outcome: { kind: 'model', rationale: reason },
        selector: { strategy: 'xpath', value: xpathFor(picked.node), stability: 'fragile' },
        ...(within ? { within } : {}),
        node: picked.node,
      };
    },
  };
}
