import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { completeJson, estimateTokens, extractJson, JSON_RETRY_MESSAGE, LlmError, NoopLlm, type ChatMessage, type CompleteOptions, type LlmPort } from '../src';

/** Answers from a list; an Error entry rejects. */
function scripted(answers: (string | Error)[]): LlmPort & { calls: { messages: ChatMessage[]; opts?: CompleteOptions }[] } {
  const calls: { messages: ChatMessage[]; opts?: CompleteOptions }[] = [];
  return {
    available: true,
    contextTokens: 32_768,
    calls,
    estimateTokens,
    async complete(messages, opts) {
      calls.push({ messages, ...(opts ? { opts } : {}) });
      const next = answers.shift();
      if (next === undefined) throw new Error('no more answers');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const Pick = z.object({ index: z.number().int().nullable(), confidence: z.number(), reason: z.string() });
const ask: ChatMessage[] = [{ role: 'user', content: 'pick one' }];

describe('token estimate', () => {
  it('divides characters by 3.5 and rounds up', () => {
    expect(estimateTokens('x'.repeat(20_000))).toBe(5715);
    expect(estimateTokens('')).toBe(0);
    const noop = new NoopLlm();
    expect(noop.available).toBe(false);
    expect(noop.contextTokens).toBe(32_768);
    expect(noop.estimateTokens('x'.repeat(20_000))).toBe(5715);
  });

  it('rejects with an unavailable error from the noop adapter', async () => {
    const port: LlmPort = new NoopLlm();
    await expect(port.complete([])).rejects.toMatchObject({ name: 'LlmError', kind: 'unavailable' });
  });
});

describe('completeJson', () => {
  it('strips a think block and a code fence', async () => {
    expect(extractJson('<think>\nhmm {not this}\n</think>\n```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(extractJson('Sure: {"a": 1} done')).toBe('{"a": 1}');
    const llm = scripted(['```json\n{ "index": 2, "confidence": 0.9, "reason": "price with currency" }\n```']);
    const result = await completeJson(llm, ask, Pick, { maxTokens: 200, noThinking: true });
    expect(result).toEqual({ ok: true, value: { index: 2, confidence: 0.9, reason: 'price with currency' } });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.opts).toEqual({ maxTokens: 200, noThinking: true, json: true });
  });

  it('retries once on a malformed answer and then reports the failure', async () => {
    const llm = scripted(['not json at all', 'still not json']);
    const result = await completeJson(llm, ask, Pick);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(LlmError);
    expect(result.error.kind).toBe('invalid-output');
    expect(result.error.message).toContain('not JSON');
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.messages.at(-1)).toEqual({ role: 'user', content: JSON_RETRY_MESSAGE });
    expect(llm.calls[1]!.messages.at(-2)).toEqual({ role: 'assistant', content: 'not json at all' });
  });

  it('names the schema path that failed', async () => {
    const llm = scripted(['{"index": 1, "reason": "x"}', '{"index": "one", "confidence": 1, "reason": "x"}']);
    const result = await completeJson(llm, ask, Pick);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/at \$\.index/);
  });

  it('succeeds on the retry', async () => {
    const llm = scripted(['oops', '{"index": null, "confidence": 0.8, "reason": "none fits"}']);
    expect(await completeJson(llm, ask, Pick)).toEqual({ ok: true, value: { index: null, confidence: 0.8, reason: 'none fits' } });
  });

  it('passes adapter errors through without a retry and never throws', async () => {
    const llm = scripted([new LlmError('network', 'connect ECONNREFUSED'), '{}']);
    const result = await completeJson(llm, ask, Pick);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: 'network', message: 'connect ECONNREFUSED' }) });
    expect(llm.calls).toHaveLength(1);
    const plain = scripted([new Error('boom')]);
    expect(await completeJson(plain, ask, Pick)).toMatchObject({ ok: false, error: { kind: 'network', message: 'boom' } });
  });
});
