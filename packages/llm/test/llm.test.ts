import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmError, MockLlm, OpenAiCompatibleLlm, type FetchLike } from '../src';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** A fetch that records requests and answers from a handler. */
function fakeFetch(handler: (call: Call) => Response | Promise<Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return handler(call);
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

const chat = (content: string) => Response.json({ choices: [{ message: { role: 'assistant', content } }] });
const hanging: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), { once: true }));

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A port nothing listens on: bind one, then close it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

describe('OpenAiCompatibleLlm', () => {
  it('shapes a JSON request with thinking disabled', async () => {
    const fetch = fakeFetch(() => chat('{"index": 1}'));
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://127.0.0.1:11434/v1/', model: 'qwen3.5:9b', fetch });
    const answer = await llm.complete([{ role: 'user', content: 'hi' }], { json: true, noThinking: true, maxTokens: 200 });
    expect(answer).toBe('{"index": 1}');
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call!.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(call!.method).toBe('POST');
    expect(call!.headers).not.toHaveProperty('authorization');
    expect(call!.body).toEqual({
      model: 'qwen3.5:9b',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      max_tokens: 200,
      stream: false,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: 'none',
    });
  });

  it('sends a bearer token only with a key, and neither json nor thinking keys unless asked', async () => {
    const fetch = fakeFetch(() => chat('hello'));
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://h/v1', model: 'm', apiKey: 'sk-1', temperature: 0.2, fetch });
    await llm.complete([{ role: 'user', content: 'hi' }]);
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer sk-1');
    expect(fetch.calls[0]!.body).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 4096, stream: false });
    expect(llm.estimateTokens('x'.repeat(20_000))).toBe(5715);
    expect(llm.contextTokens).toBe(32_768);
  });

  it('retries a 400 once without chat_template_kwargs', async () => {
    const fetch = fakeFetch((call) => (call.body && 'chat_template_kwargs' in call.body ? new Response('unknown field chat_template_kwargs', { status: 400 }) : chat('{}')));
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://h/v1', model: 'm', fetch });
    expect(await llm.complete([{ role: 'user', content: 'hi' }], { noThinking: true })).toBe('{}');
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[1]!.body).not.toHaveProperty('chat_template_kwargs');
    expect(fetch.calls[1]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('does not retry other HTTP errors and reports the status', async () => {
    const fetch = fakeFetch(() => new Response('model not loaded', { status: 500 }));
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://h/v1', model: 'm', fetch });
    const result = await llm.request([{ role: 'user', content: 'hi' }], { noThinking: true });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: 'http', status: 500 }) });
    if (!result.ok) expect(result.error.message).toContain('model not loaded');
    expect(fetch.calls).toHaveLength(1);
    await expect(llm.complete([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LlmError);
  });

  it('returns a network error for a refused connection, without a retry', async () => {
    const port = await closedPort();
    const calls: string[] = [];
    const fetch: FetchLike = (url, init) => (calls.push(url), globalThis.fetch(url, init));
    const llm = new OpenAiCompatibleLlm({ endpoint: `http://127.0.0.1:${port}/v1`, model: 'm', timeoutMs: 5000, fetch });
    const started = performance.now();
    const result = await llm.request([{ role: 'user', content: 'hi' }], { json: true, noThinking: true });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
      expect(result.error.message).toContain(`127.0.0.1:${port}`);
      expect(result.error.message).toContain('ECONNREFUSED');
    }
    expect(calls).toHaveLength(1);
  });

  it('times out a request that never answers', async () => {
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://h/v1', model: 'm', timeoutMs: 100, fetch: hanging });
    const started = performance.now();
    const result = await llm.request([{ role: 'user', content: 'hi' }]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: 'timeout' }) });
  });

  it('reports a response without message content', async () => {
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://h/v1', model: 'm', fetch: fakeFetch(() => Response.json({ choices: [] })) });
    expect(await llm.request([])).toEqual({ ok: false, error: expect.objectContaining({ kind: 'invalid-response' }) });
  });
});

describe('output cap and effort', () => {
  const msg = [{ role: 'user' as const, content: 'hi' }];
  const bodyOf = (opts: ConstructorParameters<typeof OpenAiCompatibleLlm>[0], call = {}) => new OpenAiCompatibleLlm(opts).body(msg, call);
  const base = { endpoint: 'http://h/v1', model: 'm' };

  it('sends the smallest cap under the configured field', () => {
    const b = bodyOf({ ...base, maxTokensField: 'max_completion_tokens', maxOutputTokens: 1024 }, { maxTokens: 200 });
    expect(b).toMatchObject({ max_completion_tokens: 200 });
    expect(b).not.toHaveProperty('max_tokens');
    expect(bodyOf({ ...base, maxOutputTokens: 1024 }, { maxOutputTokens: 2048 })).toMatchObject({ max_tokens: 1024 });
    expect(bodyOf(base)).toMatchObject({ max_tokens: 4096 });
  });

  it('maps each effort level', () => {
    expect(bodyOf(base)).not.toHaveProperty('reasoning_effort');
    expect(bodyOf(base, { effort: 'default' })).not.toHaveProperty('chat_template_kwargs');
    expect(bodyOf(base, { effort: 'none' })).toMatchObject({ reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
    expect(bodyOf(base, { noThinking: true })).toMatchObject({ reasoning_effort: 'none' });
    const high = bodyOf({ ...base, effort: 'high' });
    expect(high).toMatchObject({ reasoning_effort: 'high' });
    expect(high).not.toHaveProperty('chat_template_kwargs');
    expect(bodyOf({ ...base, effort: 'high' }, { effort: 'low' })).toMatchObject({ reasoning_effort: 'low' });
  });

  it('retries a 400 once without reasoning_effort', async () => {
    const fetch = fakeFetch((call) => (call.body && 'reasoning_effort' in call.body ? new Response('bad', { status: 400 }) : chat('ok')));
    const llm = new OpenAiCompatibleLlm({ ...base, fetch });
    expect(await llm.complete(msg, { effort: 'low' })).toBe('ok');
    expect(fetch.calls).toHaveLength(2);
    const failing = new OpenAiCompatibleLlm({ ...base, fetch: fakeFetch(() => new Response('bad', { status: 400 })) });
    expect(await failing.request(msg, { effort: 'low' })).toEqual({ ok: false, error: expect.objectContaining({ status: 400 }) });
  });
});

describe('retry on busy answers', () => {
  const msg = [{ role: 'user' as const, content: 'hi' }];
  const base = { endpoint: 'http://h/v1', model: 'm' };
  const busy = (status: number, headers: Record<string, string> = {}) => new Response('busy', { status, headers });

  afterEach(() => vi.useRealTimers());

  it('retries a 503 once and logs the wait', async () => {
    vi.useFakeTimers();
    const answers = [busy(503), chat('ok')];
    const fetch = fakeFetch(() => answers.shift()!);
    const log: string[] = [];
    const llm = new OpenAiCompatibleLlm({ ...base, fetch, log: (l) => log.push(l) });
    const pending = llm.request(msg);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetch.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, value: 'ok' });
    expect(log).toEqual(['llm: HTTP 503, retrying in 0.5 s']);
  });

  it('honors Retry-After in seconds and as a date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const answers = [busy(429, { 'retry-after': '2' }), busy(503, { 'retry-after': new Date('2026-01-01T00:00:05Z').toUTCString() }), chat('ok')];
    const fetch = fakeFetch(() => answers.shift()!);
    const llm = new OpenAiCompatibleLlm({ ...base, fetch });
    const pending = llm.request(msg);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetch.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, value: 'ok' });
  });

  it('stops when the budget is exhausted', async () => {
    vi.useFakeTimers();
    const fetch = fakeFetch(() => busy(503));
    const llm = new OpenAiCompatibleLlm({ ...base, fetch, retryBudgetMs: 1000 });
    const pending = llm.request(msg);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ ok: false, error: expect.objectContaining({ status: 503 }) });
    expect(fetch.calls).toHaveLength(2);
  });

  it('does not retry with a zero budget or on 500', async () => {
    const f503 = fakeFetch(() => busy(503));
    expect((await new OpenAiCompatibleLlm({ ...base, fetch: f503, retryBudgetMs: 0 }).request(msg)).ok).toBe(false);
    expect(f503.calls).toHaveLength(1);
    const f500 = fakeFetch(() => busy(500));
    expect((await new OpenAiCompatibleLlm({ ...base, fetch: f500 }).request(msg)).ok).toBe(false);
    expect(f500.calls).toHaveLength(1);
  });

  it('redacts the key from errors', async () => {
    const fetch = fakeFetch(() => new Response('bad key sk-abc', { status: 401 }));
    const result = await new OpenAiCompatibleLlm({ ...base, apiKey: 'sk-abc', fetch }).request(msg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('***');
      expect(result.error.message).not.toContain('sk-abc');
    }
  });
});

describe('probe', () => {
  it('reports override ids the endpoint does not list', async () => {
    const fetch = fakeFetch((call) => (call.url.endsWith('/models') ? Response.json({ data: [{ id: 'm' }] }) : chat('O')));
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://h/v1', model: 'm', overrideModels: ['m', 'gpt-x'], fetch });
    expect(await llm.probe()).toMatchObject({ modelFound: true, unlistedOverrides: ['gpt-x'] });
  });

  const models = (...ids: string[]) => Response.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

  it('finds the model and times a one-token completion', async () => {
    const fetch = fakeFetch((call) => (call.url.endsWith('/models') ? models('qwen3.5:9b', 'llama3') : chat('O')));
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://h/v1', model: 'qwen3.5:9b', fetch });
    const probe = await llm.probe();
    expect(probe).toEqual({ reachable: true, modelFound: true, models: ['qwen3.5:9b', 'llama3'], latencyMs: expect.any(Number) });
    expect(fetch.calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'http://h/v1/models'],
      ['POST', 'http://h/v1/chat/completions'],
    ]);
    expect(fetch.calls[1]!.body).toMatchObject({ max_tokens: 1 });
  });

  it('reports a missing model with the names available', async () => {
    const fetch = fakeFetch(() => models('qwen3.5:9b'));
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://h/v1', model: 'qwen3.5:14b', fetch });
    expect(await llm.probe()).toEqual({ reachable: true, modelFound: false, models: ['qwen3.5:9b'], latencyMs: null });
    expect(fetch.calls).toHaveLength(1);
  });

  it('returns within the timeout for an unreachable endpoint', async () => {
    const llm = new OpenAiCompatibleLlm({ endpoint: 'http://10.255.255.1/v1', model: 'm', timeoutMs: 150, fetch: hanging });
    const started = performance.now();
    const probe = await llm.probe();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(probe).toMatchObject({ reachable: false, modelFound: false, models: [], latencyMs: null, error: expect.stringContaining('150 ms') });
  });
});

describe('MockLlm', () => {
  it('answers a scripted pick and records the request', async () => {
    const llm = new MockLlm({ responses: [{ reply: '{ "index": 2, "reason": "price with currency" }' }] });
    expect(llm.available).toBe(true);
    const answer = await llm.complete([{ role: 'user', content: 'field: price' }], { json: true });
    expect(JSON.parse(answer)).toEqual({ index: 2, reason: 'price with currency' });
    expect(llm.requests).toEqual([{ messages: [{ role: 'user', content: 'field: price' }], opts: { json: true }, prompt: 'field: price' }]);
    expect(llm.remaining).toBe(0);
  });

  it('matches by predicate, consumes in order, and keeps repeating entries', async () => {
    const llm = new MockLlm({
      responses: [
        { match: (p) => p.includes('rating'), reply: 'r1' },
        { match: (p) => p.includes('price'), reply: 'p', repeat: true },
        { reply: (p) => `echo ${p}` },
        { match: (p) => p.includes('rating'), reply: 'r2' },
      ],
    });
    const ask = (content: string) => llm.complete([{ role: 'user', content }]);
    expect(await ask('price')).toBe('p');
    expect(await ask('rating')).toBe('r1');
    expect(await ask('price')).toBe('p');
    expect(await ask('title')).toBe('echo title');
    expect(await ask('rating')).toBe('r2');
    await expect(ask('title')).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(llm.requests).toHaveLength(6);
  });

  it('rejects with scripted errors as LlmError', async () => {
    const llm = new MockLlm({ responses: [{ reply: new Error('connect ECONNREFUSED') }, { reply: new LlmError('timeout', 'slow') }] });
    await expect(llm.complete([])).rejects.toMatchObject({ name: 'LlmError', kind: 'network', message: 'connect ECONNREFUSED' });
    await expect(llm.complete([])).rejects.toMatchObject({ kind: 'timeout', message: 'slow' });
  });
});
