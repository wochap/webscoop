import { existsSync } from 'node:fs';
import type { ProbeResult } from '@webscoop/llm';
import { loadConfig, type Config } from '../config';
import type { CliIo } from '../context';
import { detectDisplay } from '../display';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { canProbe, createLlm, llmSettings, type Probeable } from '../llm';
import { resolvePaths } from '../paths';

/** Below this context window the model prompt budget gets too small to be useful. */
export const MIN_CONTEXT_TOKENS = 8192;

export interface DoctorOptions {
  /** Check the endpoint; the adapter's own probe by default. Injectable for tests. */
  probe?: (llm: Probeable) => Promise<ProbeResult>;
}

/** Doctor lines for a probe result. Every problem is a warning; none changes the exit code. */
export function probeLines(endpoint: string, model: string, probe: ProbeResult): [string, string][] {
  if (!probe.reachable) return [['llm probe', `warning: ${endpoint} is unreachable${probe.error ? ` (${probe.error})` : ''}`]];
  if (!probe.modelFound) {
    const available = probe.models.length > 0 ? `; available: ${probe.models.join(', ')}` : '';
    return [['llm probe', `warning: model ${model} is not listed by ${endpoint}${available}${probe.error ? ` (${probe.error})` : ''}`]];
  }
  if (probe.latencyMs === null) return [['llm probe', `warning: model ${model} found, but a one-token completion failed${probe.error ? ` (${probe.error})` : ''}`]];
  return [['llm probe', `reachable, model ${model} found, ${probe.latencyMs} ms round trip`]];
}

export async function doctorCommand(io: CliIo, opts: DoctorOptions = {}): Promise<Code> {
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
        : `missing: ${chromium.path} (${where}${chromium.error ? `: ${chromium.error}` : ''}); run: npx playwright install chromium`,
    ]);
    const llm = llmSettings(config, io.env);
    lines.push(['llm', llm.endpoint ? `${llm.endpoint}${llm.model ? ` (model ${llm.model})` : ' (warning: no model configured, the model rung is off)'}` : 'not configured']);
    if (llm.endpoint && llm.model) {
      const adapter = createLlm(config, io.env, io.cwd);
      if (canProbe(adapter)) {
        const probe = await (opts.probe ?? ((a: Probeable) => a.probe()))(adapter);
        lines.push(...probeLines(llm.endpoint, llm.model, probe));
      } else {
        lines.push(['llm probe', 'skipped (WEBSCOOP_LLM_MOCK is set)']);
      }
      const context = adapter.contextTokens;
      lines.push([
        'llm context',
        context < MIN_CONTEXT_TOKENS
          ? `warning: ${context} tokens is below ${MIN_CONTEXT_TOKENS}; prompts will list few candidates`
          : `${context} tokens (prompts use at most ${Math.floor(context * 0.4)})`,
      ]);
    }
  }

  const width = Math.max(...lines.map(([k]) => k.length));
  io.stdout.write(`${lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n')}\n`);
  return ok ? ExitCode.Ok : ExitCode.Error;
}
