import type { z } from 'zod';
import { LlmError, type ChatMessage, type CompleteOptions, type LlmPort } from '../ports';

export type JsonResult<T> = { ok: true; value: T } | { ok: false; error: LlmError };

/** Appended as a user message when the first answer was not the JSON asked for. */
export const JSON_RETRY_MESSAGE = 'Output only the JSON object, with no other text.';

/**
 * The JSON text inside a model answer: a leading `<think>...</think>` block
 * and surrounding code fences are removed. When text remains around the
 * object, the span from the first `{` to the last `}` is taken.
 */
export function extractJson(answer: string): string {
  let text = answer.trim().replace(/^<think>[\s\S]*?<\/think>/, '').trim();
  const fence = /^```[\w-]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(text);
  if (fence) text = fence[1]!.trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }
  return text;
}

function parseAnswer<T>(answer: string, schema: z.ZodType<T>): JsonResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(answer));
  } catch (error) {
    return { ok: false, error: new LlmError('invalid-output', `the answer is not JSON: ${(error as Error).message}`) };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0]!;
  const path = ['$', ...issue.path.map(String)].join('.');
  return { ok: false, error: new LlmError('invalid-output', `the answer does not match the schema at ${path}: ${issue.message}`) };
}

function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  return new LlmError('network', error instanceof Error ? error.message : String(error));
}

/**
 * Ask for a JSON object and validate it. A malformed or invalid answer is
 * retried once with an instruction to output only JSON; adapter errors are
 * returned as they are, without a retry. Never throws.
 */
export async function completeJson<T>(
  llm: LlmPort,
  messages: readonly ChatMessage[],
  schema: z.ZodType<T>,
  opts: CompleteOptions = {},
): Promise<JsonResult<T>> {
  const request = { ...opts, json: true };
  let conversation: ChatMessage[] = [...messages];
  let result: JsonResult<T> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let answer: string;
    try {
      answer = await llm.complete(conversation, request);
    } catch (error) {
      return { ok: false, error: asLlmError(error) };
    }
    result = parseAnswer(answer, schema);
    if (result.ok) return result;
    conversation = [...conversation, { role: 'assistant', content: answer }, { role: 'user', content: JSON_RETRY_MESSAGE }];
  }
  return result!;
}
