import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, type RecipeInput } from '@webscoop/core';
import { expect, hasDisplay, test } from './fixtures';

test.skip(!hasDisplay, 'the recorder and the CLI need WAYLAND_DISPLAY or DISPLAY');

const css = (value: string) => ({ selectors: [{ strategy: 'css' as const, value, stability: 'medium' as const }] });
type Step = NonNullable<RecipeInput['flows']>[number]['steps'][number];
const fill = (selector: string, value: string): Step => ({ kind: 'fill', target: css(selector), value });

/** A recipe that fills every kind on the forms page from variables, submits, and extracts the echo. */
function formsRecipe(port: number): RecipeInput {
  return {
    schemaVersion: 2,
    name: 'forms',
    url: `http://127.0.0.1:${port}/forms`,
    vars: [
      { name: 'user', type: 'string', default: 'Ada Lovelace' },
      { name: 'pass', type: 'string', secret: true },
      { name: 'city', type: 'string', default: 'Lima' },
      { name: 'code', type: 'string', default: '482913' },
      { name: 'resume', type: 'path' },
      { name: 'video', type: 'path' },
    ],
    flows: [
      {
        name: 'fill-form',
        steps: [
          fill('#text', '{user}'),
          fill('#email', 'ada@example.test'),
          fill('#password', '{pass}'),
          fill('#textarea', 'line one'),
          fill('#select', 'Peru'),
          fill('#multiselect', 'Spanish\nqu'),
          fill('#checkbox', 'true'),
          fill('#radio-pro', 'true'),
          fill('#switch', 'true'),
          fill('#date', '1815-12-10'),
          fill('#controlled', 'Ada'),
          fill('#combobox', '{city}'),
          fill('#otp-0', '{code}'),
          fill('#notes', 'some notes'),
          fill('#shadow', 'in the shadow'),
          fill('#file', '{resume}'),
          fill('#chooser-button', '{video}'),
          { kind: 'click', target: css('#submit') },
          { kind: 'wait', target: css('#echo') },
        ],
      },
    ],
    fields: [{ name: 'echo', type: 'text', scope: 'page', selectors: [{ strategy: 'css', value: '#echo', stability: 'medium' }] }],
    sequence: [{ flow: 'fill-form' }, { extract: 'items' }],
    // The password input would read as a login wall.
    guards: [{ kind: 'login', enabled: false }],
  } as RecipeInput;
}

test('a recipe fills every kind from variables: the password from --var-command, files from path variables', async ({ scoop }) => {
  await scoop.writeRecipe(formsRecipe(scoop.playground.port));
  const a = join(scoop.home, 'a.txt');
  const clip = join(scoop.home, 'clip.bin');
  await writeFile(a, 'twelve bytes');
  await writeFile(clip, Buffer.alloc(300));
  const run = await scoop.run(['run', 'forms', '--var-command', 'pass=printf hunter2', '--var', `resume=${a}:${clip}`, '--var', `video=${a}`, '--report']);
  expect(run.code, run.stderr).toBe(0);
  expect(run.stderr).not.toContain('hunter2');
  const [row] = JSON.parse(run.stdout) as { echo: string }[];
  expect(JSON.parse(row!.echo)).toEqual({
    text: 'Ada Lovelace',
    email: 'ada@example.test',
    password: 'hunter2',
    textarea: 'line one',
    select: 'PE',
    multiselect: ['es', 'qu'],
    checkbox: true,
    radio: 'pro',
    switch: true,
    date: '1815-12-10',
    controlled: 'Ada',
    combobox: 'Lima',
    otp: '482913',
    contenteditable: 'some notes',
    shadow: 'in the shadow',
    file: [
      { name: 'a.txt', size: 12 },
      { name: 'clip.bin', size: 300 },
    ],
    chooser: [{ name: 'a.txt', size: 12 }],
    dropzone: [],
  });

  const missing = await scoop.run(['run', 'forms', '--var-command', 'pass=printf hunter2', '--var', `resume=${a}`, '--var', 'video=missing.mp4']);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toMatch(/variable "video": no readable file at missing\.mp4/);
});

test('recording: a typed password becomes a secret variable and a chosen file a path variable; saving writes no password', async ({ scoop }) => {
  const a = join(scoop.home, 'a.txt');
  await writeFile(a, 'twelve bytes');
  const r = await scoop.record([`http://127.0.0.1:${scoop.playground.port}/forms`, '--name', 'forms-rec']);
  await r.until((s) => s.host?.url.endsWith('/forms'));
  await r.browse();
  await r.typeOnPage('#password', 'hunter2');
  await r.click('#text');
  await r.until((s) => s.host?.draft.flows[0]?.steps.length === 1);
  await r.page.locator('#file').setInputFiles(a);
  const state = await r.until((s) => (s.host?.draft.flows[0]?.steps.length === 2 ? s : undefined));
  const steps = state.host!.draft.flows[0]!.steps.map((s) => [s.kind, s.value]);
  expect(steps).toEqual([
    ['fill', '{password}'],
    ['fill', '{resume}'],
  ]);
  const vars = state.host!.draft.vars;
  expect(vars.find((v) => v.name === 'password')).toMatchObject({ secret: true, value: '', set: true });
  expect(vars.find((v) => v.name === 'resume')).toMatchObject({ type: 'path', value: '' });
  expect(JSON.stringify(state.host)).not.toContain('hunter2');

  // Keys typed while a page input has focus go to the page.
  await r.click('h1');
  await r.key('b');
  await r.until((s) => !s.ui.browsing);
  await r.key('Control+s');
  const saved = await r.until((s) => (s.host?.saved && !s.host.draft.dirty ? s.host.saved : undefined));
  expect((await r.closeWindow()).code).toBe(0);
  const text = await readFile(saved.path!, 'utf8');
  expect(text).not.toContain('hunter2');
  const recipe = loadRecipe(text);
  expect(recipe.vars).toEqual([
    { name: 'password', type: 'string', secret: true },
    { name: 'resume', type: 'path' },
  ]);
});
