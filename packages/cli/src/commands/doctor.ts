import { existsSync } from 'node:fs';
import { loadConfig, type Config } from '../config';
import type { CliIo } from '../context';
import { detectDisplay } from '../display';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { resolvePaths } from '../paths';

export async function doctorCommand(io: CliIo): Promise<Code> {
  const paths = resolvePaths(io.env, io.homedir);
  const lines: [string, string][] = [];
  let ok = true;

  let config: Config | undefined;
  try {
    config = await loadConfig(paths);
    lines.push(['config', `${paths.configFile} (${existsSync(paths.configFile) ? 'found' : 'not found, using defaults'})`]);
  } catch (error) {
    ok = false;
    lines.push(['config', `${paths.configFile} (invalid: ${error instanceof CliError ? error.message : String(error)})`]);
  }
  lines.push(['paths from', paths.source]);
  lines.push(['recipes', paths.recipesDir]);
  lines.push(['profiles', paths.profilesDir]);

  const display = detectDisplay(io.env);
  if (!display.available) ok = false;
  lines.push(['display', display.available ? display.description : `missing: ${display.description}`]);

  if (config) {
    const chromium = await io.chromium(config, io.env);
    if (!chromium.installed) ok = false;
    const where = chromium.source === 'override' ? 'override' : 'playwright build';
    lines.push([
      'chromium',
      chromium.installed
        ? `${chromium.path} (${where}${chromium.version ? `, ${chromium.version}` : ''})`
        : `missing: ${chromium.path} (${where}${chromium.error ? `: ${chromium.error}` : ''}); run: pnpm exec playwright install chromium`,
    ]);
    const llm = config.llm;
    lines.push(['llm', llm.endpoint ? `${llm.endpoint}${llm.model ? ` (model ${llm.model})` : ''}` : 'not configured']);
  }

  const width = Math.max(...lines.map(([k]) => k.length));
  io.stdout.write(`${lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n')}\n`);
  return ok ? ExitCode.Ok : ExitCode.Error;
}
