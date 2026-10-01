import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoopLlm } from '@webscoop/core';
import { MockLlm, OpenAiCompatibleLlm } from '@webscoop/llm';
import { describe, expect, it } from 'vitest';
import { CliError, ConfigSchema, createLlm, llmSettings, loadConfig, resolvePaths } from '../src';
import { tempDir } from './helpers';

const config = (llm: Record<string, unknown> = {}) => ConfigSchema.parse({ llm });

describe('createLlm', () => {
  it('builds the client from environment variables when the config has no llm block', () => {
    const llm = createLlm(config(), { WEBSCOOP_LLM_ENDPOINT: 'http://127.0.0.1:11434/v1', WEBSCOOP_LLM_MODEL: 'qwen3.5:9b' });
    expect(llm).toBeInstanceOf(OpenAiCompatibleLlm);
    expect(llm.available).toBe(true);
    const client = llm as OpenAiCompatibleLlm;
    expect(client.endpoint).toBe('http://127.0.0.1:11434/v1');
    expect(client.model).toBe('qwen3.5:9b');
    expect(client.contextTokens).toBe(32_768);
    expect(client.timeoutMs).toBe(60_000);
  });

  it('lets the environment override the file, and keeps the other file settings', () => {
    const file = config({ endpoint: 'http://file.test/v1', model: 'file-model', apiKey: 'k1', contextTokens: 8192, timeoutMs: 5000, temperature: 0.3 });
    expect(llmSettings(file, { WEBSCOOP_LLM_MODEL: 'env-model', WEBSCOOP_LLM_API_KEY: 'k2' })).toEqual({
      endpoint: 'http://file.test/v1',
      model: 'env-model',
      apiKey: 'k2',
      contextTokens: 8192,
      timeoutMs: 5000,
      temperature: 0.3,
    });
    const llm = createLlm(file, { WEBSCOOP_LLM_ENDPOINT: 'http://env.test/v1' }) as OpenAiCompatibleLlm;
    expect(llm.endpoint).toBe('http://env.test/v1');
    expect(llm.model).toBe('file-model');
    expect(llm.contextTokens).toBe(8192);
    expect(llm.timeoutMs).toBe(5000);
  });

  it('is unavailable when the model is missing', async () => {
    const llm = createLlm(config({ endpoint: 'http://127.0.0.1:11434/v1' }), {});
    expect(llm).toBeInstanceOf(NoopLlm);
    expect(llm.available).toBe(false);
    expect(createLlm(config(), { WEBSCOOP_LLM_MODEL: 'm' }).available).toBe(false);
    expect(createLlm(config(), { WEBSCOOP_LLM_ENDPOINT: ' ' , WEBSCOOP_LLM_MODEL: 'm' }).available).toBe(false);
  });

  it('loads a mock script from WEBSCOOP_LLM_MOCK, relative to the working directory', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'script.json'),
      JSON.stringify({ responses: [{ match: 'price', pick: 'data-qa="price"', reason: 'price element' }, { reply: { index: null, confidence: 1, reason: 'none' } }] }),
    );
    const llm = createLlm(config({ endpoint: 'http://unused/v1', model: 'm' }), { WEBSCOOP_LLM_MOCK: 'script.json' }, dir);
    expect(llm).toBeInstanceOf(MockLlm);
    const prompt = 'Field: price\n#1 <span data-qa="label"> "Cost:"\n#2 <span data-qa="price"> "$24.99"';
    expect(JSON.parse(await llm.complete([{ role: 'user', content: prompt }]))).toEqual({ index: 2, confidence: 0.9, reason: 'price element' });
    expect(JSON.parse(await llm.complete([{ role: 'user', content: 'Field: rating' }]))).toEqual({ index: null, confidence: 1, reason: 'none' });
  });

  it('loads the tier 3 and tier 4 fixtures', async () => {
    const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'llm');
    const prompt = (field: string, lines: string[]) => [{ role: 'user' as const, content: [`Field: ${field}`, 'Type: number', 'Candidates:', ...lines].join('\n') }];
    const lines = ['#1 <span> "Cost:"', '#2 <span data-qa="price"> "$24.99"', '#3 <p role="paragraph" data-qa="rating" title="Rated 4.5 out of 5"> "4.5"'];
    const three = createLlm(config(), { WEBSCOOP_LLM_MOCK: 'tier3.json' }, fixtures);
    expect(JSON.parse(await three.complete(prompt('price', lines)))).toMatchObject({ index: 2, reason: 'price with currency' });
    expect(JSON.parse(await three.complete(prompt('rating', lines)))).toMatchObject({ index: 3 });
    expect(JSON.parse(await three.complete(prompt('price', lines)))).toMatchObject({ index: 2 });
    const four = createLlm(config(), { WEBSCOOP_LLM_MOCK: join(fixtures, 'tier4.json') });
    expect(JSON.parse(await four.complete(prompt('rating', lines)))).toEqual({ index: null, confidence: 0.95, reason: 'no rating element on the card' });
    expect(JSON.parse(await four.complete(prompt('price', lines)))).toMatchObject({ index: 2 });
  });

  it('rejects an unreadable or invalid mock script', async () => {
    const dir = await tempDir();
    expect(() => createLlm(config(), { WEBSCOOP_LLM_MOCK: 'missing.json' }, dir)).toThrow(/WEBSCOOP_LLM_MOCK: cannot read/);
    await writeFile(join(dir, 'bad.json'), JSON.stringify([{ match: 'x' }]));
    expect(() => createLlm(config(), { WEBSCOOP_LLM_MOCK: 'bad.json' }, dir)).toThrow(/exactly one of reply, error, or pick/);
  });
});

describe('llm key sources', () => {
  const keyOf = (llm: unknown) => (llm as { apiKey?: string }).apiKey;
  const base = { endpoint: 'http://127.0.0.1:11434/v1', model: 'm' };

  it('rejects more than one key source at $.llm', async () => {
    for (const llm of [
      { apiKey: 'k', apiKeyFile: 'f' },
      { apiKeyFile: 'f', apiKeyCommand: 'c' },
      { apiKey: 'k', apiKeyCommand: 'c' },
    ]) {
      const home = await tempDir();
      await writeFile(join(home, 'config.json'), JSON.stringify({ llm }));
      await expect(loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h'))).rejects.toThrow(/\$\.llm: set at most one/);
    }
  });

  it('resolves a relative key file against the config directory and reads it trimmed', async () => {
    const home = await tempDir();
    await mkdir(join(home, 'secrets'));
    await writeFile(join(home, 'secrets', 'llm-key'), 'sk-abc\n');
    await writeFile(join(home, 'config.json'), JSON.stringify({ llm: { ...base, apiKeyFile: 'secrets/llm-key' } }));
    const loaded = await loadConfig(resolvePaths({ WEBSCOOP_HOME: home }, '/h'));
    expect(loaded.llm.apiKeyFile).toBe(join(home, 'secrets', 'llm-key'));
    expect(keyOf(createLlm(loaded, {}))).toBe('sk-abc');
  });

  it('uses the environment key without reading the file', () => {
    const llm = createLlm(config({ ...base, apiKeyFile: '/nonexistent/key' }), { WEBSCOOP_LLM_API_KEY: 'env' });
    expect(keyOf(llm)).toBe('env');
  });

  it('reads WEBSCOOP_LLM_API_KEY_FILE against cwd over the config key', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'k'), ' sk-env-file \n');
    const llm = createLlm(config({ ...base, apiKey: 'cfg' }), { WEBSCOOP_LLM_API_KEY_FILE: 'k' }, dir);
    expect(keyOf(llm)).toBe('sk-env-file');
  });

  it('errors naming the path when the key file is missing or empty', async () => {
    expect(() => createLlm(config({ ...base, apiKeyFile: '/nonexistent/key' }), {})).toThrow(/\/nonexistent\/key/);
    const dir = await tempDir();
    await writeFile(join(dir, 'empty'), '\n');
    expect(() => createLlm(config({ ...base, apiKeyFile: join(dir, 'empty') }), {})).toThrow(/empty/);
  });

  it('does not read the key file without an endpoint and model', () => {
    expect(createLlm(config({ apiKeyFile: '/nonexistent/key' }), {}).available).toBe(false);
    expect(createLlm(config({ model: 'm', apiKeyCommand: 'exit 1' }), {}).available).toBe(false);
  });

  it('uses the trimmed stdout of the key command', () => {
    expect(keyOf(createLlm(config({ ...base, apiKeyCommand: 'printf "sk-xyz\\n"' }), {}))).toBe('sk-xyz');
  });

  it('reports exit status and stderr, never stdout, when the key command fails', () => {
    const run = () => createLlm(config({ ...base, apiKeyCommand: 'echo secret-out; echo boom >&2; exit 3' }), {});
    expect(run).toThrow(CliError);
    try {
      run();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/exit status 3/);
      expect(message).toMatch(/boom/);
      expect(message).not.toMatch(/secret-out/);
    }
    expect(() => createLlm(config({ ...base, apiKeyCommand: 'true' }), {})).toThrow(/printed nothing/);
  });

  it('skips the key command when the environment key is set', async () => {
    const dir = await tempDir();
    const marker = join(dir, 'ran');
    const llm = createLlm(config({ ...base, apiKeyCommand: `touch ${marker}; echo k` }), { WEBSCOOP_LLM_API_KEY: 'env' });
    expect(keyOf(llm)).toBe('env');
    expect(existsSync(marker)).toBe(false);
  });
});
