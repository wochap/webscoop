import { exportAndRun, hasPythonPlaywright } from './export-fixture';
import { expect, hasDisplay, HOVER_RECIPE, referenceRecipe, test, type Scoop } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

type Row = { title: string; url: string };

async function runRows(scoop: Scoop, name: string, args: string[] = [], env: Record<string, string> = {}): Promise<Row[]> {
  const run = await scoop.run(['run', name, ...args], env);
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Row[];
}

const path = (url: string) => new URL(url).pathname;

test('a hover field reads every real link, with and without humanized input, and the obfuscated one without the flag', async ({ scoop }) => {
  await scoop.writeRecipe(referenceRecipe(scoop.playground.port, HOVER_RECIPE));

  const plain = await runRows(scoop, 'playground-hover');
  expect(plain).toHaveLength(24);
  for (const row of plain) expect(path(row.url)).toMatch(/^\/p\/p\d+$/);

  const human = await runRows(scoop, 'playground-hover', ['--humanize', '--profile', 'human'], { WEBSCOOP_HUMANIZE_SPEED: '20' });
  expect(human).toEqual(plain);

  const recipe = referenceRecipe(scoop.playground.port, HOVER_RECIPE);
  recipe.name = 'hover-off';
  recipe.fields = recipe.fields!.map((f) => ({ ...f, hover: false }));
  await scoop.writeRecipe(recipe);
  const off = await runRows(scoop, 'hover-off');
  expect(off).toHaveLength(24);
  for (const row of off) expect(path(row.url)).toMatch(/^\/r\//);
});

for (const format of ['ts', 'py'] as const) {
  test(`the exported ${format === 'ts' ? 'TypeScript' : 'Python'} script hovers like webscoop run`, async ({ scoop }) => {
    test.skip(format === 'py' && !hasPythonPlaywright, 'no Python with Playwright');
    await scoop.writeRecipe(referenceRecipe(scoop.playground.port, HOVER_RECIPE));
    const out = await exportAndRun(scoop, 'playground-hover', format);
    expect(out.code, out.stderr).toBe(0);
    expect(out.rows).toHaveLength(24);
    expect(out.rows).toEqual(await runRows(scoop, 'playground-hover'));
  });
}
