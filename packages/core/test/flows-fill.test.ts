import { describe, expect, it } from 'vitest';
import { loadRecipe, runFlow, RunFailure, RunWindows, type FilePort, type Recipe, type RecipeInput, type Session, type Step } from '../src';
import { FakeBrowser, h, type FakePage } from '../src/testing';
import { css, PAGE, recipe } from './helpers';

type StepInput = Omit<Step, 'window' | 'optional'> & Partial<Pick<Step, 'window' | 'optional'>>;

const target = (selector: string) => ({ selectors: [css(selector)] });

function withSteps(steps: StepInput[], vars: RecipeInput['vars'] = []): Recipe {
  return loadRecipe(recipe({ url: PAGE, vars, flows: [{ name: 'setup', steps }], sequence: [{ flow: 'setup' }, { extract: 'items' }] }));
}

async function open(page: FakePage) {
  const browser = new FakeBrowser({ [PAGE]: page });
  const session = await browser.open('/p');
  await session.goto(PAGE, { timeoutMs: 1000 });
  return { browser, session };
}

function replay(session: Session, r: Recipe, vars: Record<string, string> = {}, files?: FilePort) {
  return runFlow(r, r.flows[0]!, session, { windows: new RunWindows(session), page: 1, timeoutMs: 1000, cache: new Map(), vars, ...(files ? { files } : {}) });
}

const form = () =>
  h(
    'html',
    {},
    h(
      'body',
      {},
      h('input', { type: 'checkbox', id: 'terms', checked: '' }),
      h('div', { role: 'switch', id: 'news', 'aria-checked': 'false' }),
      h('input', { type: 'radio', id: 'plan' }),
      h('select', { id: 'tags', multiple: '' }, h('option', { value: 'a' }, 'Alpha'), h('option', { value: 'b' }, 'Beta'), h('option', { value: 'c' }, 'Gamma')),
      h('input', { role: 'combobox', id: 'city' }),
      h('ul', { role: 'listbox' }, h('li', { role: 'option' }, 'Lima'), h('li', { role: 'option' }, 'Cusco')),
      h('div', {}, ...Array.from({ length: 6 }, (_, i) => h('input', { maxlength: '1', id: `otp${i}` }))),
      h('input', { type: 'file', id: 'video', multiple: '' }),
      h('button', { id: 'pick', 'data-file-chooser': '' }, 'Select file'),
      h('button', { id: 'plain' }, 'Nothing'),
    ),
  );

describe('fill by element kind', () => {
  it('clicks a checkbox or switch only when its state differs, and a radio to choose it', async () => {
    const { browser, session } = await open({ dom: form() });
    await replay(
      session,
      withSteps([
        { kind: 'fill', target: target('#terms'), value: 'true' },
        { kind: 'fill', target: target('#news'), value: 'true' },
        { kind: 'fill', target: target('#plan'), value: 'true' },
      ]),
    );
    expect(browser.clicks).toEqual(['css=#news >> nth=0', 'css=#plan >> nth=0']);
    expect(await session.read((await session.resolve(css('#news')))[0]!, { attr: 'aria-checked', mode: 'text' })).toBe('true');
  });

  it('fails naming the step for a radio set to false', async () => {
    const { session } = await open({ dom: form() });
    const run = replay(session, withSteps([{ kind: 'fill', target: target('#plan'), value: 'false', label: 'plan' }]));
    await expect(run).rejects.toThrow(/step 0 \(fill\) of flow "setup" could not run: a radio cannot be set to false/);
  });

  it('chooses each line of a multiple select', async () => {
    const { session } = await open({ dom: form() });
    await replay(session, withSteps([{ kind: 'fill', target: target('#tags'), value: 'Alpha\nc' }]));
    const selected = await session.resolve(css('#tags option[selected]'));
    expect(selected).toHaveLength(2);
  });

  it('types into a combobox and clicks the option, or fails when none shows', async () => {
    const { browser, session } = await open({ dom: form() });
    await replay(session, withSteps([{ kind: 'fill', target: target('#city'), value: 'Lima' }]));
    expect(browser.clicks).toEqual(['option Lima']);
    const missing = replay(session, withSteps([{ kind: 'fill', target: target('#city'), value: 'Quito' }]));
    await expect(missing).rejects.toThrow(/found no element: .*no option "Quito"/);
  });

  it('spreads an OTP value over the boxes', async () => {
    const { session } = await open({ dom: form() });
    await replay(session, withSteps([{ kind: 'fill', target: target('#otp0'), value: '482913' }]));
    const values = await Promise.all(Array.from({ length: 6 }, async (_, i) => session.read((await session.resolve(css(`#otp${i}`)))[0]!, { attr: 'value', mode: 'text' })));
    expect(values).toEqual(['4', '8', '2', '9', '1', '3']);
  });

  it('hands every path of a path variable to a file input, resolved and checked on the host', async () => {
    const { browser, session } = await open({ dom: form() });
    const checked: string[] = [];
    const files: FilePort = { resolve: (p) => `/work/${p}`, readable: async (p) => (checked.push(p), true) };
    await replay(session, withSteps([{ kind: 'fill', target: target('#video'), value: '{clips}' }], [{ name: 'clips', type: 'path' }]), { clips: 'a.mp4:b.mp4' }, files);
    expect(checked).toEqual(['/work/a.mp4', '/work/b.mp4']);
    expect(browser.actions.at(-1)).toEqual({ kind: 'files', target: 'css=#video >> nth=0', value: '/work/a.mp4:/work/b.mp4' });
  });

  it('opens the chooser of a button for a path variable, and fails when none opens', async () => {
    const { browser, session } = await open({ dom: form() });
    const vars = [{ name: 'video', type: 'path' as const }];
    await replay(session, withSteps([{ kind: 'fill', target: target('#pick'), value: '{video}' }], vars), { video: '/tmp/a.txt' });
    expect(browser.actions.at(-1)).toMatchObject({ kind: 'files', value: '/tmp/a.txt' });
    const none = replay(session, withSteps([{ kind: 'fill', target: target('#plain'), value: '{video}' }], vars), { video: '/tmp/a.txt' });
    await expect(none).rejects.toThrow(/found no element: .*opened no file chooser/);
  });

  it('fails before acting when a path does not name a readable file, naming the variable and the path', async () => {
    const { browser, session } = await open({ dom: form() });
    const files: FilePort = { resolve: (p) => `/work/${p}`, readable: async () => false };
    const run = replay(session, withSteps([{ kind: 'fill', target: target('#video'), value: '{video}' }], [{ name: 'video', type: 'path' }]), { video: 'missing.mp4' }, files);
    await expect(run).rejects.toThrow(RunFailure);
    await expect(run).rejects.toMatchObject({ reason: 'invalid-input', message: expect.stringMatching(/"video".*missing\.mp4/) });
    expect(browser.actions).toEqual([]);
  });
});
