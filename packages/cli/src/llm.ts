import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NoopLlm, type LlmPort } from '@webscoop/core';
import { mockFromScript, OpenAiCompatibleLlm, type ProbeResult } from '@webscoop/llm';
import type { Config } from './config';
import { CliError } from './exit';
import type { Env } from './paths';

/** The `llm` config block with `WEBSCOOP_LLM_*` variables applied over it. */
export function llmSettings(config: Config, env: Env): Config['llm'] {
  const fromEnv = (name: string) => env[name]?.trim() || undefined;
  const endpoint = fromEnv('WEBSCOOP_LLM_ENDPOINT') ?? config.llm.endpoint;
  const model = fromEnv('WEBSCOOP_LLM_MODEL') ?? config.llm.model;
  const apiKey = fromEnv('WEBSCOOP_LLM_API_KEY') ?? config.llm.apiKey;
  return { ...config.llm, ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}), ...(apiKey ? { apiKey } : {}) };
}

/** An adapter that can check its endpoint, for `doctor`. */
export interface Probeable {
  probe(): Promise<ProbeResult>;
}

export function canProbe(llm: LlmPort): llm is LlmPort & Probeable {
  return typeof (llm as Partial<Probeable>).probe === 'function';
}

/**
 * The language model adapter for a command: the mock script named by
 * `WEBSCOOP_LLM_MOCK` (resolved against `cwd`) when set, else the
 * OpenAI-compatible client when an endpoint and a model are configured, else
 * the unavailable adapter.
 */
export function createLlm(config: Config, env: Env, cwd = process.cwd()): LlmPort {
  const mock = env.WEBSCOOP_LLM_MOCK?.trim();
  if (mock) {
    const path = resolve(cwd, mock);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new CliError(`WEBSCOOP_LLM_MOCK: cannot read ${path}: ${(error as Error).message}`);
    }
    try {
      return mockFromScript(json);
    } catch (error) {
      throw new CliError(`WEBSCOOP_LLM_MOCK: invalid script ${path}: ${(error as Error).message}`);
    }
  }
  const s = llmSettings(config, env);
  if (!s.endpoint || !s.model) return new NoopLlm();
  return new OpenAiCompatibleLlm({
    endpoint: s.endpoint,
    model: s.model,
    ...(s.apiKey ? { apiKey: s.apiKey } : {}),
    ...(s.contextTokens ? { contextTokens: s.contextTokens } : {}),
    ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
  });
}
