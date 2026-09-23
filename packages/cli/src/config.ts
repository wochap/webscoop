import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './exit';
import type { Paths } from './paths';

export const ConfigSchema = z.object({
  llm: z
    .object({
      /** OpenAI-compatible base URL, e.g. `http://127.0.0.1:11434/v1`. Used by a later change. */
      endpoint: z.url().optional(),
      model: z.string().min(1).optional(),
      apiKey: z.string().optional(),
      contextTokens: z.number().int().positive().optional(),
    })
    .default({}),
  browser: z
    .object({
      /** Chromium binary to use instead of the build Playwright downloaded. */
      executablePath: z.string().min(1).optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

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
  return parsed.data;
}
