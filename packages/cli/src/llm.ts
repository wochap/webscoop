import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { NoopLlm, type LlmPort } from '@webscoop/core';
import { mockFromScript, OpenAiCompatibleLlm, type ProbeResult } from '@webscoop/llm';
import { configDirOf, expandPath, type Config } from './config';
import { CliError } from './exit';
import type { Env } from './paths';

/**
 * The `llm` config block with `WEBSCOOP_LLM_*` variables applied over it.
 * Exactly one key source survives: `WEBSCOOP_LLM_API_KEY`, then
 * `WEBSCOOP_LLM_API_KEY_FILE` (resolved against `cwd`), then the config's.
 * Key files are not read here.
 */
export function llmSettings(config: Config, env: Env, cwd = process.cwd()): Config['llm'] {
  const fromEnv = (name: string) => env[name]?.trim() || undefined;
  const endpoint = fromEnv('WEBSCOOP_LLM_ENDPOINT') ?? config.llm.endpoint;
  const model = fromEnv('WEBSCOOP_LLM_MODEL') ?? config.llm.model;
  const { apiKey: _k, apiKeyFile: _f, apiKeyCommand: _c, ...rest } = config.llm;
  const envKey = fromEnv('WEBSCOOP_LLM_API_KEY');
  const envKeyFile = fromEnv('WEBSCOOP_LLM_API_KEY_FILE');
  const key: Pick<Config['llm'], 'apiKey' | 'apiKeyFile' | 'apiKeyCommand'> = envKey
    ? { apiKey: envKey }
    : envKeyFile
      ? { apiKeyFile: expandPath(envKeyFile, cwd, env.HOME?.trim() || homedir()) }
      : Object.fromEntries(Object.entries({ apiKey: _k, apiKeyFile: _f, apiKeyCommand: _c }).filter(([, v]) => v));
  return { ...rest, ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}), ...key };
}

/** Read the bearer token from a key file or key command; never puts the secret in an error. */
function resolveApiKey(s: Config['llm'], cwd: string, configDir: string | undefined): string | undefined {
  if (s.apiKey) return s.apiKey;
  if (s.apiKeyFile) {
    let text: string;
    try {
      text = readFileSync(s.apiKeyFile, 'utf8');
    } catch (error) {
      throw new CliError(`llm.apiKeyFile: cannot read ${s.apiKeyFile}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    const key = text.trim();
    if (!key) throw new CliError(`llm.apiKeyFile: ${s.apiKeyFile} is empty`);
    return key;
  }
  if (s.apiKeyCommand) {
    let out: string;
    try {
      out = execFileSync('sh', ['-c', s.apiKeyCommand], {
        cwd: configDir ?? cwd,
        encoding: 'utf8',
        timeout: s.timeoutMs ?? 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { status?: number | null; signal?: string | null; stderr?: string };
      const status = e.code === 'ETIMEDOUT' ? 'timed out' : e.status != null ? `exit status ${e.status}` : e.signal ? `killed by ${e.signal}` : (e.code ?? 'failed');
      const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
      throw new CliError(`llm.apiKeyCommand: ${status}${stderr ? `: ${stderr}` : ''}`);
    }
    const key = out.trim();
    if (!key) throw new CliError('llm.apiKeyCommand: printed nothing (exit status 0)');
    return key;
  }
  return undefined;
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
  const s = llmSettings(config, env, cwd);
  if (!s.endpoint || !s.model) return new NoopLlm();
  const apiKey = resolveApiKey(s, cwd, configDirOf(config));
  return new OpenAiCompatibleLlm({
    endpoint: s.endpoint,
    model: s.model,
    ...(apiKey ? { apiKey } : {}),
    ...(s.contextTokens ? { contextTokens: s.contextTokens } : {}),
    ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
  });
}
