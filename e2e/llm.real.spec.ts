import { expect, hasDisplay, test } from './fixtures';

// Runs against a real model, on demand only:
//   WEBSCOOP_LLM_ENDPOINT=http://127.0.0.1:11434/v1 WEBSCOOP_LLM_MODEL=qwen3.5:9b npm run test:e2e -- llm.real
const endpoint = process.env.WEBSCOOP_LLM_ENDPOINT;
test.skip(!endpoint, 'set WEBSCOOP_LLM_ENDPOINT (and WEBSCOOP_LLM_MODEL) to run against a real model');
test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

interface BenchTier {
  tier: number;
  elapsedMs: number;
  ok: boolean;
  fields: { name: string; rung: string; status: string; rationale?: string; notes?: string[] }[];
}

const REQUIRED = ['item', 'title', 'price', 'url', 'image', 'rating', 'category'];

test('bench tiers 0-4 against the configured model', async ({ scoop }) => {
  test.setTimeout(15 * 60_000);
  const result = await scoop.run(['bench', 'playground-catalog', '--tiers', '0-4', '--json'], { WEBSCOOP_LLM_MOCK: undefined });
  expect(result.code, result.stderr).toBe(0);
  const tiers = JSON.parse(result.stdout) as BenchTier[];

  // Heal-rate table for the report.
  const table = tiers.map((t) => `tier ${t.tier} (${(t.elapsedMs / 1000).toFixed(1)}s): ${t.fields.map((f) => `${f.name}=${f.rung}`).join(' ')}`);
  test.info().annotations.push({ type: 'heal rates', description: table.join('\n') });
  console.log(table.join('\n'));

  const tier3 = tiers.find((t) => t.tier === 3)!;
  for (const name of REQUIRED) expect(tier3.fields.find((f) => f.name === name)?.rung, `tier 3 ${name}`).not.toBe('unresolved');
  const tier4 = tiers.find((t) => t.tier === 4)!;
  expect(tier4.fields.find((f) => f.name === 'rating')?.rung).toBe('unresolved');
});
