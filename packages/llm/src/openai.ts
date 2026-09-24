import { DEFAULT_CONTEXT_TOKENS, estimateTokens, LlmError, type ChatMessage, type CompleteOptions, type LlmPort } from '@webscoop/core';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleOptions {
  /** Base URL ending before `/chat/completions`, e.g. `http://127.0.0.1:11434/v1`. */
  endpoint: string;
  model: string;
  /** Sent as a bearer token when set. */
  apiKey?: string;
  /** Default 32768. */
  contextTokens?: number;
  /** Per-request timeout. Default 60000. */
  timeoutMs?: number;
  /** Default 0. */
  temperature?: number;
  /** Injectable for tests; the global `fetch` by default. */
  fetch?: FetchLike;
}

export type LlmResult<T> = { ok: true; value: T } | { ok: false; error: LlmError };

export interface ProbeResult {
  reachable: boolean;
  modelFound: boolean;
  /** Model ids `/models` lists. */
  models: string[];
  /** Round trip of a one-token completion, when one was made and succeeded. */
  latencyMs: number | null;
  error?: string;
}

const snippet = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

/** A client for an OpenAI-compatible chat completions endpoint, such as Ollama, llama.cpp, or vLLM. */
export class OpenAiCompatibleLlm implements LlmPort {
  readonly available = true;
  readonly contextTokens: number;
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly fetch: FetchLike;

  constructor(opts: OpenAiCompatibleOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey || undefined;
    this.contextTokens = opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.temperature = opts.temperature ?? 0;
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /** The request body for a completion. */
  body(messages: readonly ChatMessage[], opts: CompleteOptions = {}): Record<string, unknown> {
    return {
      model: this.model,
      messages,
      temperature: opts.temperature ?? this.temperature,
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      stream: false,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      // vLLM, SGLang, and llama.cpp read the chat template flag; Ollama reads `reasoning_effort`.
      ...(opts.noThinking ? { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' } : {}),
    };
  }

  private async send(url: string, init: RequestInit, signal: AbortSignal): Promise<LlmResult<Response>> {
    try {
      return { ok: true, value: await this.fetch(url, { ...init, signal }) };
    } catch (error) {
      if (signal.aborted) {
        const reason = signal.reason as Error | undefined;
        if (reason?.name === 'TimeoutError') return { ok: false, error: new LlmError('timeout', `${url} did not answer within ${this.timeoutMs} ms`) };
        return { ok: false, error: new LlmError('network', `${url}: request aborted`) };
      }
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (error as Error).message;
      return { ok: false, error: new LlmError('network', `${url} is unreachable (${detail})`) };
    }
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<LlmResult<string>> {
    const url = `${this.endpoint}/chat/completions`;
    const sent = await this.send(url, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) }, signal);
    if (!sent.ok) return sent;
    const res = sent.value;
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      return { ok: false, error: new LlmError(signal.aborted ? 'timeout' : 'network', `${url}: reading the response failed: ${(error as Error).message}`) };
    }
    if (!res.ok) return { ok: false, error: new LlmError('http', `${url} answered HTTP ${res.status}: ${snippet(text)}`, res.status) };
    let json: { choices?: { message?: { content?: unknown } }[] };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      return { ok: false, error: new LlmError('invalid-response', `${url} answered with non-JSON: ${snippet(text)}`) };
    }
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { ok: false, error: new LlmError('invalid-response', `${url} answered without a message content`) };
    return { ok: true, value: content };
  }

  private signalFor(outer?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return outer ? AbortSignal.any([timeout, outer]) : timeout;
  }

  /**
   * One completion, as a result value. A 400 answer to a request carrying the
   * thinking switches (`chat_template_kwargs`, `reasoning_effort`) is retried
   * once without them, for servers that reject unknown keys. Nothing else is
   * retried.
   */
  async request(messages: readonly ChatMessage[], opts: CompleteOptions = {}): Promise<LlmResult<string>> {
    const signal = this.signalFor(opts.signal);
    const body = this.body(messages, opts);
    const first = await this.post(body, signal);
    if (first.ok || first.error.status !== 400 || !('chat_template_kwargs' in body)) return first;
    const { chat_template_kwargs: _kwargs, reasoning_effort: _effort, ...rest } = body;
    return this.post(rest, signal);
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    const result = await this.request(messages, opts);
    if (!result.ok) throw result.error;
    return result.value;
  }

  /**
   * Check the endpoint: list `/models`, look for the configured model, and
   * time a one-token completion. Finishes within the timeout; never throws.
   */
  async probe(): Promise<ProbeResult> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const url = `${this.endpoint}/models`;
    const listed = await this.send(url, { method: 'GET', headers: this.headers(false) }, signal);
    if (!listed.ok) return { reachable: false, modelFound: false, models: [], latencyMs: null, error: listed.error.message };
    const res = listed.value;
    let models: string[] = [];
    try {
      const text = await res.text();
      if (!res.ok) return { reachable: true, modelFound: false, models, latencyMs: null, error: `${url} answered HTTP ${res.status}: ${snippet(text)}` };
      const json = JSON.parse(text) as { data?: { id?: unknown }[] };
      models = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    } catch (error) {
      return { reachable: true, modelFound: false, models, latencyMs: null, error: `${url} answered with an unreadable model list: ${(error as Error).message}` };
    }
    const modelFound = models.includes(this.model);
    if (!modelFound) return { reachable: true, modelFound, models, latencyMs: null };
    const started = performance.now();
    const pong = await this.post(this.body([{ role: 'user', content: 'Reply with OK.' }], { maxTokens: 1, noThinking: true }), signal);
    if (!pong.ok) return { reachable: true, modelFound, models, latencyMs: null, error: pong.error.message };
    return { reachable: true, modelFound, models, latencyMs: Math.round(performance.now() - started) };
  }
}
