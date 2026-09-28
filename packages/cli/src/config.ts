import { readFile } from 'node:fs/promises';
import { LocaleSchema, parseProxyUrl, PROFILE_NAME, PROXY_SCHEMES, TimezoneSchema } from '@webscoop/core';
import { z } from 'zod';
import { CliError } from './exit';
import type { Paths } from './paths';

/** A window provider: shell command templates, `{pid}` and `{workspace}` filled at run time. */
export const ProviderDefSchema = z.object({
  /** The provider applies when this variable is set and this binary is on the PATH. */
  detect: z.object({ env: z.string().min(1), binary: z.string().min(1) }),
  hide: z.string().min(1),
  show: z.string().min(1),
  focus: z.string().min(1).optional(),
  /** Run once before the browser launches, e.g. to install a compositor rule. */
  prepare: z.string().min(1).optional(),
  /** Chromium arguments for hiding runs, e.g. `--class=webscoop` for that rule to match. */
  args: z.array(z.string().min(1)).optional(),
  /** Prints the active workspace, run right before `show`; fills `{workspace}`. */
  workspace: z.string().min(1).optional(),
});

const ProxyUrlSchema = z.string().refine((v) => parseProxyUrl(v) !== null, { error: (issue) => `invalid proxy URL, expected ${PROXY_SCHEMES.join(', ')}://host:port (got a value of ${String(issue.input).length} characters)` });

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
    })
    .default({ driver: 'playwright' }),
  window: z
    .object({
      /** `auto` (default), `hyprland`, `none`, or a name from `providers`. */
      provider: z.string().min(1).default('auto'),
      /** User providers by name, tried by `auto` after the built-in ones in declaration order. */
      providers: z
        .record(z.string(), ProviderDefSchema)
        .refine((p) => !('auto' in p) && !('none' in p), { message: 'provider names auto and none are reserved' })
        .default({}),
    })
    .default({ provider: 'auto', providers: {} }),
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

/** Load the config file; a missing file yields defaults, an invalid one is an error. */
export async function loadConfig(paths: Paths): Promise<Config> {
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
  return parsed.data;
}
