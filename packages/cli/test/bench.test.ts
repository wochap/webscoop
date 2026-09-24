import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { formatBench, parseTiers } from '../src/commands/bench';
import { tempDir, testIo } from './helpers';

describe('bench', () => {
  it('parses tier ranges', () => {
    expect(parseTiers('0-4')).toEqual([0, 1, 2, 3, 4]);
    expect(parseTiers('3')).toEqual([3]);
    expect(parseTiers('3-4,0,1-2,3')).toEqual([0, 1, 2, 3, 4]);
    for (const bad of ['', '4-3', '0-5', 'a', '1-', '-1']) expect(() => parseTiers(bad), bad).toThrow(/invalid --tiers/);
  });

  it('prints one row per tier and field with the rung and the elapsed time', () => {
    const text = formatBench([
      { tier: 0, elapsedMs: 1234, ok: true, fields: [{ name: 'item', rung: 'candidate', status: 'ok' }, { name: 'price', rung: 'candidate', status: 'ok' }] },
      { tier: 3, elapsedMs: 5000, ok: true, fields: [{ name: 'price', rung: 'model', status: 'healed', rationale: 'price with currency' }] },
      { tier: 4, elapsedMs: 10, ok: false, reason: 'timeout', fields: [] },
    ]);
    expect(text.trimEnd().split('\n')).toEqual([
      'TIER  FIELD  RUNG       STATUS   TIME',
      '0     item   candidate  ok       1.23s',
      '0     price  candidate  ok       1.23s',
      '3     price  model      healed   5.00s',
      '4     -      -          timeout  0.01s',
    ]);
  });

  it('refuses a recipe without a port variable before opening anything', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(
      join(dir, 'recipes', 'shop.json'),
      JSON.stringify({ schemaVersion: 1, name: 'shop', url: 'https://shop.test/', fields: [{ name: 't', type: 'text', scope: 'page', selectors: [{ strategy: 'css', value: 'h1', stability: 'medium' }] }] }),
    );
    const io = testIo({ env: { WAYLAND_DISPLAY: 'wayland-1', WEBSCOOP_HOME: dir } });
    expect(await main(['bench', 'shop'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('has no {port} variable');
    expect(io.browserCreated()).toBe(0);
    expect(await main(['bench', 'shop', '--tiers', '9'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('tiers go from 0 to 4');
  });

  it('is listed in the help with --no-llm on run and test', async () => {
    const io = testIo({});
    expect(await main(['--help'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toMatch(/^\s+bench \[options\] <recipe>/m);
    for (const cmd of ['run', 'test', 'bench']) {
      const help = testIo({});
      expect(await main([cmd, '--help'], help)).toBe(ExitCode.Ok);
      expect(help.out(), cmd).toContain('--no-llm');
    }
  });
});
