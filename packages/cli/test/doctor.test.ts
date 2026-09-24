import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProbeResult } from '@webscoop/llm';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { doctorCommand } from '../src/commands/doctor';
import { tempDir, testIo } from './helpers';
import { join } from 'node:path';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const ENDPOINT = 'http://127.0.0.1:11434/v1';

async function withConfig(llm: Record<string, unknown>, env: Record<string, string> = DISPLAY) {
  const dir = await tempDir();
  await writeFile(join(dir, 'config.json'), JSON.stringify({ llm }));
  return testIo({ env: { ...env, WEBSCOOP_HOME: dir } });
}

const fixed = (result: ProbeResult) => async () => result;
const line = (out: string, key: string) => out.split('\n').find((l) => l.startsWith(`${key} `)) ?? '';

describe('doctor LLM probe', () => {
  it('prints the model as found with the round trip and exits 0', async () => {
    const io = await withConfig({ endpoint: ENDPOINT, model: 'qwen3.5:9b' });
    const code = await doctorCommand(io, { probe: fixed({ reachable: true, modelFound: true, models: ['qwen3.5:9b'], latencyMs: 312 }) });
    expect(code).toBe(ExitCode.Ok);
    expect(line(io.out(), 'llm probe')).toMatch(/^llm probe +reachable, model qwen3\.5:9b found, 312 ms round trip$/);
    expect(line(io.out(), 'llm context')).toMatch(/32768 tokens \(prompts use at most 13107\)$/);
  });

  it('warns about a model missing from the list, naming the models available', async () => {
    const io = await withConfig({ endpoint: ENDPOINT, model: 'qwen3.5:14b' });
    const code = await doctorCommand(io, { probe: fixed({ reachable: true, modelFound: false, models: ['qwen3.5:9b', 'llama3'], latencyMs: null }) });
    expect(code).toBe(ExitCode.Ok);
    expect(line(io.out(), 'llm probe')).toContain(`warning: model qwen3.5:14b is not listed by ${ENDPOINT}; available: qwen3.5:9b, llama3`);
  });

  it('warns about an unreachable endpoint, naming it, and still exits 0', async () => {
    const io = await withConfig({ endpoint: ENDPOINT, model: 'qwen3.5:9b' });
    const code = await doctorCommand(io, { probe: fixed({ reachable: false, modelFound: false, models: [], latencyMs: null, error: 'ECONNREFUSED' }) });
    expect(code).toBe(ExitCode.Ok);
    expect(line(io.out(), 'llm probe')).toContain(`warning: ${ENDPOINT} is unreachable (ECONNREFUSED)`);
  });

  it('keeps exit 1 for a missing display whatever the probe says', async () => {
    const io = await withConfig({ endpoint: ENDPOINT, model: 'qwen3.5:9b' }, {});
    expect(await doctorCommand(io, { probe: fixed({ reachable: true, modelFound: true, models: [], latencyMs: 1 }) })).toBe(ExitCode.Error);
  });

  it('warns when the context window is below 8192 tokens', async () => {
    const io = await withConfig({ endpoint: ENDPOINT, model: 'm', contextTokens: 4096 });
    expect(await doctorCommand(io, { probe: fixed({ reachable: true, modelFound: true, models: ['m'], latencyMs: 5 }) })).toBe(ExitCode.Ok);
    expect(line(io.out(), 'llm context')).toContain('warning: 4096 tokens is below 8192');
  });

  it('uses the environment variables and probes a refused port for real', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await new Promise((r) => server.close(r));
    const dir = await tempDir();
    const endpoint = `http://127.0.0.1:${port}/v1`;
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_LLM_ENDPOINT: endpoint, WEBSCOOP_LLM_MODEL: 'qwen3.5:9b' } });
    expect(await main(['doctor'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toContain(`${endpoint} (model qwen3.5:9b)`);
    expect(line(io.out(), 'llm probe')).toMatch(new RegExp(`warning: ${endpoint.replace(/\./g, '\\.')} is unreachable \\(.*ECONNREFUSED`));
  });

  it('does not probe without a model', async () => {
    const io = await withConfig({ endpoint: ENDPOINT });
    let probed = false;
    expect(await doctorCommand(io, { probe: async () => ((probed = true), { reachable: true, modelFound: true, models: [], latencyMs: 1 }) })).toBe(ExitCode.Ok);
    expect(probed).toBe(false);
    expect(line(io.out(), 'llm')).toContain('no model configured');
  });
});
