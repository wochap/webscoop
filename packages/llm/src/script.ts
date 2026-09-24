import { z } from 'zod';
import { MockLlm, type MockResponse } from './mock';

const Entry = z
  .object({
    /** Answer only prompts containing this text. */
    match: z.string().optional(),
    /** Keep the entry for later requests. */
    repeat: z.boolean().optional(),
    /** Literal answer: a string, or an object sent as JSON. */
    reply: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    /** Reject with an adapter error carrying this message. */
    error: z.string().optional(),
    /**
     * Regular expression over the candidate lines (`#<number> ...`) of the
     * prompt: answer the number of the first line it matches, or null.
     */
    pick: z.string().optional(),
    confidence: z.number().min(0).max(1).default(0.9),
    reason: z.string().default('scripted pick'),
  })
  .refine((e) => [e.reply, e.error, e.pick].filter((v) => v !== undefined).length === 1, {
    message: 'each response needs exactly one of reply, error, or pick',
  });

export const MockScriptSchema = z.union([
  z.array(Entry).transform((responses) => ({ responses, contextTokens: undefined })),
  z.object({ contextTokens: z.number().int().positive().optional(), responses: z.array(Entry) }),
]);

export type MockScript = z.input<typeof MockScriptSchema>;

const CANDIDATE_LINE = /^#(\d+) (.*)$/;

/** Number of the first candidate line of the prompt matching the pattern, or null. */
export function pickCandidate(prompt: string, pattern: RegExp): number | null {
  for (const line of prompt.split('\n')) {
    const m = CANDIDATE_LINE.exec(line);
    if (m && pattern.test(m[2]!)) return Number(m[1]);
  }
  return null;
}

/**
 * A mock adapter from a JSON script, as used by `WEBSCOOP_LLM_MOCK`. The
 * script is an array of responses, or `{ contextTokens?, responses }`.
 */
export function mockFromScript(json: unknown): MockLlm {
  const script = MockScriptSchema.parse(json);
  const responses: MockResponse[] = script.responses.map((e) => {
    const match = e.match;
    const base = { ...(match !== undefined ? { match: (prompt: string) => prompt.includes(match) } : {}), ...(e.repeat ? { repeat: true } : {}) };
    if (e.error !== undefined) return { ...base, reply: new Error(e.error) };
    if (e.pick !== undefined) {
      const pattern = new RegExp(e.pick);
      return {
        ...base,
        reply: (prompt: string) => {
          const index = pickCandidate(prompt, pattern);
          return JSON.stringify({ index, confidence: e.confidence, reason: index === null ? 'no candidate matches' : e.reason });
        },
      };
    }
    return { ...base, reply: typeof e.reply === 'string' ? e.reply : JSON.stringify(e.reply) };
  });
  return new MockLlm({ responses, ...(script.contextTokens ? { contextTokens: script.contextTokens } : {}) });
}
