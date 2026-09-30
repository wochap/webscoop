import { readFile } from 'node:fs/promises';
import { LocaleSchema, parseProxyUrl, PROFILE_NAME, PROXY_SCHEMES, TimezoneSchema } from '@webscoop/core';
import { z } from 'zod';
import { CliError } from './exit';
import type { Paths } from './paths';

const ProxyUrlSchema = z.string().refine((v) => parseProxyUrl(v) !== null, { error: (issue) => `invalid proxy URL, expected ${PROXY_SCHEMES.join(', ')}://host:port (got a value of ${String(issue.input).length} characters)` });

/** Lifecycle events a hook can run on. */
export const HOOK_EVENTS = [
  'browser.starting',
  'browser.started',
  'browser.closed',
  'run.start',
  'run.done',
  'run.failed',
  'attention.needed',
  'attention.resolved',
  'browser.show',
  'browser.hide',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Default `hookTimeoutMs`. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

const HookCommandsSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const ProfileNameSchema = z.string().regex(PROFILE_NAME, 'invalid profile name: start with a letter or digit, then letters, digits, ., _, or -');

const PatternSchema = z.string().superRefine((value, ctx) => {
  try {
    new RegExp(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: `invalid regular expression: ${(error as Error).message}` });
  }
});

/** A profile rule: `host` and `name` are unanchored regular expressions; every key present must match. */
export const ProfileRuleSchema = z
  .object({ host: PatternSchema.optional(), name: PatternSchema.optional(), profile: ProfileNameSchema })
  .refine((r) => r.host !== undefined || r.name !== undefined, { message: 'a profile rule needs host, name, or both' });

export const ConfigSchema = z.object({
  llm: z
    .object({
      /** OpenAI-compatible base URL ending before `/chat/completions`, e.g. `http://127.0.0.1:11434/v1`. */
      endpoint: z.url().optional(),
      model: z.string().min(1).optional(),
      /** Sent as a bearer token when set. */
      apiKey: z.string().optional(),
      /** Context window of the model; prompts are budgeted to 40 percent of it. Default 32768. */
      contextTokens: z.number().int().positive().optional(),
      /** Per-request timeout. Default 60000. */
      timeoutMs: z.number().int().positive().optional(),
      /** Sampling temperature. Default 0. */
      temperature: z.number().min(0).max(2).optional(),
    })
    .default({}),
  browser: z
    .object({
      /** Chromium binary to use instead of the build Playwright downloaded. */
      executablePath: z.string().min(1).optional(),
      /** Automation driver: `playwright` (default) or `patchright`. */
      driver: z.enum(['playwright', 'patchright']).default('playwright'),
      /** `chromium` or `chrome`; defaults to `chromium` with Playwright and `chrome` with Patchright. */
      channel: z.enum(['chromium', 'chrome']).optional(),
      /** Default proxy: a URL, or an object with the URL and a bypass list. Credentials may sit in the URL. */
      proxy: z.union([ProxyUrlSchema, z.object({ server: ProxyUrlSchema, bypass: z.union([z.string().min(1), z.array(z.string().min(1))]).optional() })]).optional(),
      timezone: TimezoneSchema.optional(),
      locale: LocaleSchema.optional(),
      /** Humanized input by default for `run`, `test`, and `bench`. */
      humanize: z.boolean().optional(),
      /** Extra Chromium arguments for every launch, e.g. `--class=webscoop` for a window manager rule. */
      args: z.array(z.string().min(1)).optional(),
    })
    .default({ driver: 'playwright' }),
  /** Shell commands per lifecycle event: one command line or a list, run in order. */
  hooks: z.partialRecord(z.enum(HOOK_EVENTS), HookCommandsSchema).optional(),
  /** Longest a hook command may run before it is killed. Default 5000. */
  hookTimeoutMs: z.number().int().positive().optional(),
  /** No longer supported; loaded with a warning and ignored. */
  window: z.unknown().optional(),
  profiles: z
    .object({
      /** Profile used when no rule matches; without it, the recipe name. */
      default: ProfileNameSchema.optional(),
      /** Ordered rules; the first that matches the recipe wins. */
      rules: z.array(ProfileRuleSchema).default([]),
    })
    .default({ rules: [] }),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface CompiledProfileRule {
  host?: RegExp;
  name?: RegExp;
  profile: string;
}

const compiledRules = new WeakMap<Config, CompiledProfileRule[]>();

/** The profile rules of a config as `RegExp` values, compiled once per config object. */
export function profileRules(config: Config): CompiledProfileRule[] {
  let rules = compiledRules.get(config);
  if (!rules) {
    rules = (config.profiles?.rules ?? []).map((r) => ({
      ...(r.host !== undefined ? { host: new RegExp(r.host) } : {}),
      ...(r.name !== undefined ? { name: new RegExp(r.name) } : {}),
      profile: r.profile,
    }));
    compiledRules.set(config, rules);
  }
  return rules;
}

/** The commands configured for an event, in order. */
export function hookCommands(config: Config, event: HookEvent): string[] {
  const commands = config.hooks?.[event];
  if (commands === undefined) return [];
  return typeof commands === 'string' ? [commands] : commands;
}

/** Warning for a config that still has a `window` block. */
export const WINDOW_CONFIG_WARNING = 'warning: the config "window" block is no longer supported and is ignored; use "hooks" (for example attention.needed and attention.resolved) instead';

/**
 * Load the config file; a missing file yields defaults, an invalid one is an
 * error. `warn` receives the warning for a leftover `window` block.
 */
export async function loadConfig(paths: Paths, warn?: (message: string) => void): Promise<Config> {
  let text: string;
  try {
    text = await readFile(paths.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ConfigSchema.parse({});
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new CliError(`${paths.configFile}: invalid JSON: ${(error as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${['$', ...i.path].join('.')}: ${i.message}`);
    throw new CliError(`${paths.configFile}: invalid config\n${lines.join('\n')}`);
  }
  profileRules(parsed.data);
  if (parsed.data.window !== undefined) warn?.(WINDOW_CONFIG_WARNING);
  return parsed.data;
}
