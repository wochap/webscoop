import { DEFAULT_CONTEXT_TOKENS, estimateTokens, LlmError, type ChatMessage, type CompleteOptions, type LlmPort } from '@webscoop/core';

export interface MockResponse {
  /** Only answer prompts this accepts; the prompt is every message's content joined by blank lines. */
  match?: (prompt: string) => boolean;
  /** The answer, an error to reject with, or a function of the prompt. */
  reply: string | Error | ((prompt: string) => string);
  /** Keep the entry for later requests instead of consuming it. */
  repeat?: boolean;
}

export interface MockRequest {
  messages: ChatMessage[];
  opts: CompleteOptions;
  prompt: string;
}

/** Stand-in for a model in tests: answers from a scripted list and records every request. */
export class MockLlm implements LlmPort {
  readonly available = true;
  readonly contextTokens: number;
  readonly requests: MockRequest[] = [];
  private readonly responses: MockResponse[];

  constructor(opts: { responses: MockResponse[]; contextTokens?: number }) {
    this.responses = [...opts.responses];
    this.contextTokens = opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  }

  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  /** Scripted entries not consumed yet. */
  get remaining(): number {
    return this.responses.length;
  }

  /** The first unconsumed entry whose predicate accepts the prompt answers; entries without one match anything. */
  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    const prompt = messages.map((m) => m.content).join('\n\n');
    this.requests.push({ messages: [...messages], opts, prompt });
    const index = this.responses.findIndex((r) => !r.match || r.match(prompt));
    if (index === -1) throw new LlmError('invalid-response', 'the mock has no scripted response for this prompt');
    const entry = this.responses[index]!;
    if (!entry.repeat) this.responses.splice(index, 1);
    if (entry.reply instanceof Error) throw entry.reply instanceof LlmError ? entry.reply : new LlmError('network', entry.reply.message);
    return typeof entry.reply === 'function' ? entry.reply(prompt) : entry.reply;
  }
}
