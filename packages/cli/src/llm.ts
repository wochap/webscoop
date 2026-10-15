import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { NoopLlm, type LlmPort } from '@webscoop/core';
import { mockFromScript, OpenAiCompatibleLlm, type ProbeResult } from '@webscoop/llm';
import { configDirOf, expandPath, type Config, type LlmEntry } from './config';
import { CliError } from './exit';
import type { Env } from './paths';

/**
 * The `llm` config block with `WEBSCOOP_LLM_*` variables applied over it.
 * Exactly one key source survives: `WEBSCOOP_LLM_API_KEY`, then
 * `WEBSCOOP_LLM_API_KEY_FILE` (resolved against `cwd`), then the config's.
 * Key files are not read here.
 */
export function llmSettings(config: Config, env: Env, cwd = process.cwd()): LlmEntry {
  const fromEnv = (name: string) => env[name]?.trim() || undefined;
  const endpoint = fromEnv('WEBSCOOP_LLM_ENDPOINT') ?? config.llm.endpoint;
  const model = fromEnv('WEBSCOOP_LLM_MODEL') ?? config.llm.model;
  const { apiKey: _k, apiKeyFile: _f, apiKeyCommand: _c, ...rest } = config.llm;
  const envKey = fromEnv('WEBSCOOP_LLM_API_KEY');
  const envKeyFile = fromEnv('WEBSCOOP_LLM_API_KEY_FILE');
  const key: Pick<LlmEntry, 'apiKey' | 'apiKeyFile' | 'apiKeyCommand'> = envKey
    ? { apiKey: envKey }
    : envKeyFile
      ? { apiKeyFile: expandPath(envKeyFile, cwd, env.HOME?.trim() || homedir()) }
      : Object.fromEntries(Object.entries({ apiKey: _k, apiKeyFile: _f, apiKeyCommand: _c }).filter(([, v]) => v));
  return { ...rest, ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}), ...key };
}

/** Read the bearer token from a key file or key command; never puts the secret in an error. */
function resolveApiKey(s: LlmEntry, label: string, cwd: string, configDir: string | undefined): string | undefined {
  if (s.apiKey) return s.apiKey;
  if (s.apiKeyFile) {
    let text: string;
    try {
      text = readFileSync(s.apiKeyFile, 'utf8');
    } catch (error) {
      throw new CliError(`${label}.apiKeyFile: cannot read ${s.apiKeyFile}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    const key = text.trim();
    if (!key) throw new CliError(`${label}.apiKeyFile: ${s.apiKeyFile} is empty`);
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
      throw new CliError(`${label}.apiKeyCommand: ${status}${stderr ? `: ${stderr}` : ''}`);
    }
    const key = out.trim();
    if (!key) throw new CliError(`${label}.apiKeyCommand: printed nothing (exit status 0)`);
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

/** The name of the entry the config's `llm` block provides. */
export const DEFAULT_LLM = 'default';

/** Entry names in order: `default`, then the keys of `llms` in file order. */
export function llmEntryNames(config: Config): string[] {
  return [DEFAULT_LLM, ...Object.keys(config.llms)];
}

/**
 * An entry's settings with the `models` override for its `model` applied.
 * `WEBSCOOP_LLM_*` variables apply to `default` only.
 */
export function entrySettings(config: Config, name: string, env: Env, cwd = process.cwd()): LlmEntry {
  const entry = name === DEFAULT_LLM ? llmSettings(config, env, cwd) : config.llms[name];
  if (!entry) checkLlmName(config, name);
  if (!entry) throw new CliError(`unknown LLM entry "${name}"`);
  const override = entry.model ? entry.models?.[entry.model] : undefined;
  return override ? { ...entry, ...Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined)) } : entry;
}

/** Throws a `CliError` naming the entry and the defined ones when `name` is not defined. */
export function checkLlmName(config: Config, name: string): void {
  if (name !== DEFAULT_LLM && !(name in config.llms)) {
    throw new CliError(`unknown LLM entry "${name}"; defined: ${llmEntryNames(config).join(', ')}`);
  }
}

export interface ResolveLlmOptions {
  /** An entry a caller names; wins over `flag`. */
  name?: string | undefined;
  /** The `--llm` value. */
  flag?: string | undefined;
  /** Receives one line before each retry wait. */
  log?: ((line: string) => void) | undefined;
}

const adapters = new WeakMap<Config, WeakMap<Env, Map<string, LlmPort>>>();

function loadMock(mock: string, cwd: string): LlmPort {
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

/**
 * The language model adapter for a command: the entry named by the caller,
 * else by `--llm`, else `default`. `WEBSCOOP_LLM_MOCK` (resolved against
 * `cwd`) answers every defined entry; otherwise the OpenAI-compatible client
 * when the entry has an endpoint and a model, else the unavailable adapter.
 * Each entry is built once per config and environment, so key files and key
 * commands run once.
 */
export function resolveLlm(config: Config, env: Env, cwd = process.cwd(), opts: ResolveLlmOptions = {}): LlmPort {
  const name = opts.name ?? opts.flag ?? DEFAULT_LLM;
  checkLlmName(config, name);
  let byEnv = adapters.get(config);
  if (!byEnv) adapters.set(config, (byEnv = new WeakMap()));
  let byName = byEnv.get(env);
  if (!byName) byEnv.set(env, (byName = new Map()));
  const cached = byName.get(name);
  if (cached) return cached;
  const llm = build(config, name, env, cwd, opts.log);
  byName.set(name, llm);
  return llm;
}

function build(config: Config, name: string, env: Env, cwd: string, log: ((line: string) => void) | undefined): LlmPort {
  const mock = env.WEBSCOOP_LLM_MOCK?.trim();
  if (mock) return loadMock(mock, cwd);
  const s = entrySettings(config, name, env, cwd);
  if (!s.endpoint || !s.model) return new NoopLlm();
  const apiKey = resolveApiKey(s, name === DEFAULT_LLM ? 'llm' : `llms.${name}`, cwd, configDirOf(config));
  return new OpenAiCompatibleLlm({
    endpoint: s.endpoint,
    model: s.model,
    ...(apiKey ? { apiKey } : {}),
    ...(s.contextTokens ? { contextTokens: s.contextTokens } : {}),
    ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
    ...(s.maxOutputTokens ? { maxOutputTokens: s.maxOutputTokens } : {}),
    ...(s.maxTokensField ? { maxTokensField: s.maxTokensField } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.retryBudgetMs !== undefined ? { retryBudgetMs: s.retryBudgetMs } : {}),
    ...(s.models ? { overrideModels: Object.keys(s.models) } : {}),
    ...(log ? { log } : {}),
  });
}

/** The default entry's adapter; see `resolveLlm`. */
export function createLlm(config: Config, env: Env, cwd = process.cwd()): LlmPort {
  return resolveLlm(config, env, cwd);
}
