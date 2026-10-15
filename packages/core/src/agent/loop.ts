import { completeJson } from '../llm/json';
import { RunFailure } from '../failure';
import type { RunWindows } from '../flows/windows';
import type { ChatMessage, LlmPort, PageInfo, SavedDownload, SerializedNode, Session } from '../ports';
import { ACTION_HELP, AgentActions, AnswerSchema, invalidAnswerResult, parseAction, type AgentAction } from './actions';
import { buildOutline, outlineBudget, type Outline } from './outline';

/** Consecutive answers that fail the action schema before the loop gives up. */
export const MAX_INVALID_ANSWERS = 3;
/** Output tokens assumed for an adapter that does not say. */
const DEFAULT_OUTPUT_TOKENS = 1024;

export type AgentEnd = 'download' | 'done' | 'done-unmet' | 'gave-up' | 'max-turns' | 'llm-error' | 'invalid-answers' | 'no-llm';

/** One turn of the loop as the report shows it. */
export interface AgentTurn {
  turn: number;
  /** The action's name, or `invalid` for an answer that did not fit the schema. */
  action: string;
  ref?: string;
  /** The outline line of `ref`. */
  target?: string;
  reason: string;
  /** First line of the action's result. */
  result: string;
}

export interface AgentReport {
  turns: number;
  end: AgentEnd;
  actions: AgentTurn[];
}

export interface AgentResult {
  /** Whether the step reached its goal: a download for `until: download`, else `done`. */
  ok: boolean;
  report: AgentReport;
  /** Why the loop failed, in a sentence, when it did. */
  why?: string;
}

export interface AgentLoopOptions {
  llm: LlmPort;
  /** The step's window. */
  session: Session;
  windows: RunWindows;
  /** The goal with variables substituted. */
  goal: string;
  maxTurns: number;
  until?: 'download';
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Called with the settled page when an action navigated the main window, for guards. */
  onNavigated?: (info: PageInfo) => Promise<PageInfo>;
  /** Called after each turn. */
  onTurn?: (turn: AgentTurn) => void;
}

const SYSTEM = [
  'You operate a web page in a browser to reach a goal. You see the page as an outline of numbered elements and act on it one step at a time.',
  'Outline lines look like: [e3] button "Export". Refs (e1, e2, ...) belong to the latest outline only.',
  'Answer with exactly one JSON object per turn and nothing else. The valid answers are:',
  ACTION_HELP,
  'Scope: you stay on the page you start on. An action that navigates to another page is undone, and popups that show a page are closed. Opening a file download is allowed.',
  'Work toward the goal. When it is reached, answer done. When it cannot be reached, answer give_up.',
].join('\n');

const titleOf = (tree: SerializedNode): string => {
  if (tree.type !== 'element') return '';
  if (tree.tag === 'title') return tree.children.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
  for (const c of tree.children) {
    const t = titleOf(c);
    if (t) return t;
  }
  return '';
};

/** Stored per turn after the first request. */
interface Exchange {
  /** The model's answer. */
  answer: string;
  /** What the action did. */
  result: string;
}

const firstLine = (text: string) => text.split('\n', 1)[0]!;

/**
 * Drive the step's window toward a goal: outline, ask for one JSON action,
 * run it, repeat. Ends on evidence (a saved download), on the model's word,
 * or on a cap. Throws only for an abort or an unexpected browser failure.
 */
export async function runAgent(opts: AgentLoopOptions): Promise<AgentResult> {
  const { llm, session, windows } = opts;
  const estimate = (text: string) => llm.estimateTokens(text);
  let downloaded: SavedDownload | null = null;
  const off = session.onDownload((d) => {
    downloaded ??= d;
  });
  const startUrl = await session.url();
  const actions = new AgentActions({
    session,
    windows,
    timeoutMs: opts.timeoutMs,
    startUrl,
    sleep: opts.sleep,
    ...(opts.onNavigated ? { onNavigated: opts.onNavigated } : {}),
    stop: () => opts.until === 'download' && downloaded !== null,
  });
  const report: AgentReport = { turns: 0, end: 'max-turns', actions: [] };
  const finish = (end: AgentEnd, why?: string): AgentResult => {
    report.end = end;
    return { ok: end === 'download' || end === 'done', report, ...(why ? { why } : {}) };
  };
  const wantsDownload = opts.until === 'download';
  const exchanges: Exchange[] = [];
  let invalid = 0;
  let doneAsked = 0;
  try {
    for (let turn = 1; turn <= opts.maxTurns; turn++) {
      if (opts.signal?.aborted) throw new RunFailure('aborted', 'run was interrupted');
      if (wantsDownload && downloaded) return finish('download');
      if (session.isClosed()) return finish('gave-up', 'the window closed');

      const tree = await session.snapshot();
      const goalText = `Goal: ${opts.goal}\nStart URL: ${startUrl}\nPage title: ${titleOf(tree)}`;
      const fixed = estimate(SYSTEM) + estimate(goalText);
      const contextTokens = llm.contextTokens;
      const outline = buildOutline(tree, outlineBudget(contextTokens, fixed), estimate);
      const messages = conversation(goalText, exchanges, outline, {
        estimate,
        limit: contextTokens - (llm.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS) - estimate(outline.text),
      });

      const answer = await completeJson(llm, messages, AnswerSchema, { temperature: 0 });
      if (opts.signal?.aborted) throw new RunFailure('aborted', 'run was interrupted');
      report.turns = turn;
      const note = (entry: Omit<AgentTurn, 'turn'>) => {
        const full: AgentTurn = { turn, ...entry };
        report.actions.push(full);
        opts.onTurn?.(full);
      };
      if (!answer.ok && answer.error.kind !== 'invalid-output') {
        note({ action: 'invalid', reason: '', result: `the model failed: ${firstLine(answer.error.message)}` });
        return finish('llm-error', answer.error.message);
      }
      if (wantsDownload && downloaded) return finish('download');

      const parsed = answer.ok ? parseAction(answer.value) : { ok: false as const, problem: answer.error.message };
      if (!parsed.ok) {
        invalid++;
        const result = invalidAnswerResult(parsed.problem);
        note({ action: 'invalid', reason: '', result: firstLine(result) });
        if (invalid >= MAX_INVALID_ANSWERS) return finish('invalid-answers', parsed.problem);
        exchanges.push({ answer: '(invalid answer)', result });
        continue;
      }
      invalid = 0;
      const action = parsed.action;
      const ref = 'ref' in action ? action.ref : undefined;
      const target = ref !== undefined ? outline.line(ref) : undefined;
      const entry = { action: action.action, ...(ref !== undefined ? { ref } : {}), ...(target !== undefined ? { target } : {}), reason: action.reason };
      const answerText = JSON.stringify(compact(action));

      if (action.action === 'give_up') {
        note({ ...entry, result: action.reason || 'gave up' });
        return finish('gave-up', action.reason);
      }
      if (action.action === 'done') {
        if (!wantsDownload) {
          note({ ...entry, result: 'done' });
          return finish('done');
        }
        doneAsked++;
        const result = 'No download has been saved yet. Keep going, or answer give_up.';
        note({ ...entry, result });
        if (doneAsked >= 2) return finish('done-unmet', 'the model said it was done but no download was saved');
        exchanges.push({ answer: answerText, result });
        continue;
      }

      const outcome = await actions.run(action, outline);
      if (outcome.stopped || (wantsDownload && downloaded)) {
        note({ ...entry, result: `a download was saved as ${downloaded ? (downloaded as SavedDownload).name : 'a file'}` });
        return finish('download');
      }
      note({ ...entry, result: firstLine(outcome.text) });
      exchanges.push({ answer: answerText, result: outcome.text });
    }
    return finish('max-turns', `no result after ${opts.maxTurns} turns`);
  } finally {
    off();
  }
}

/** The action without its empty `reason`, as the model wrote it. */
function compact(action: AgentAction): Record<string, unknown> {
  const { reason, ...rest } = action;
  return reason ? { ...rest, reason } : rest;
}

/**
 * The messages of a request: the system message, the goal, the turns so far,
 * and the current outline. Older turns keep their answer and the first line
 * of their result; the latest result is whole and carries the outline. The
 * oldest turns are dropped until the conversation fits `limit` tokens.
 */
export function conversation(goalText: string, exchanges: readonly Exchange[], outline: Outline, budget: { estimate: (text: string) => number; limit: number }): ChatMessage[] {
  const last = exchanges.at(-1);
  const older = exchanges.slice(0, -1);
  const head: ChatMessage[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: last ? goalText : `${goalText}\n\nOutline:\n${outline.text}` }];
  const tail: ChatMessage[] = last
    ? [
        { role: 'assistant', content: last.answer },
        { role: 'user', content: `${last.result}\n\nOutline:\n${outline.text}` },
      ]
    : [];
  const turns = older.map((e): ChatMessage[] => [
    { role: 'assistant', content: e.answer },
    { role: 'user', content: firstLine(e.result) },
  ]);
  const size = (parts: ChatMessage[][]) => budget.estimate([...head, ...parts.flat(), ...tail].map((m) => m.content).join('\n'));
  // The outline in the latest message is budgeted separately.
  const outlineTokens = last ? budget.estimate(outline.text) : 0;
  let kept = turns;
  while (kept.length > 0 && size(kept) - outlineTokens > budget.limit) kept = kept.slice(1);
  return [...head, ...kept.flat(), ...tail];
}
