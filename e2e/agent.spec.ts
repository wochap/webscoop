import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeInput } from '@webscoop/core';
import { CHECKOUT_AGENT_RECIPE, e2eConfig, expect, FORM_AGENT_RECIPE, hasDisplay, LLM_FIXTURES, LOGIN_AGENT_RECIPE, PDF_AGENT_RECIPE, test } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');

const mock = (name: string) => ({ WEBSCOOP_LLM_MOCK: join(LLM_FIXTURES, `${name}.json`), WEBSCOOP_LLM_ENDPOINT: undefined, WEBSCOOP_LLM_MODEL: undefined });

async function setup(scoop: { writeRecipe(r: RecipeInput): Promise<string>; playground: { port: number }; home: string }) {
  await scoop.writeRecipe(JSON.parse(await readFile(PDF_AGENT_RECIPE, 'utf8')) as RecipeInput);
  return { url: `http://127.0.0.1:${scoop.playground.port}/pdf-links`, dir: join(scoop.home, 'out') };
}

interface DownloadRow {
  file: string;
  name: string;
  url: string;
  bytes: number;
  _page: number;
  _index: number;
}

for (const [name, what] of [
  ['pdf-agent-link', 'the plain link'],
  ['pdf-agent-open', 'the window.open button'],
] as const) {
  test(`reaches the PDF through ${what} and prints it as a downloads row`, async ({ scoop }) => {
    const { url, dir } = await setup(scoop);
    const result = await scoop.run(['run', 'playground-pdf-agent', '--var', `url=${url}`, '--download-dir', dir], mock(name));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/agent: click \[e\d\] /);
    expect(result.stderr).toMatch(/agent: grab:0 ended: download after 1 turn/);
    const rows = JSON.parse(result.stdout) as DownloadRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.file).toMatch(/\.pdf$/);
    expect((await readdir(dir)).filter((f) => f.endsWith('.pdf'))).toHaveLength(1);
  });
}

test('exits 3 when the model says done without a download', async ({ scoop }) => {
  const { url, dir } = await setup(scoop);
  const result = await scoop.run(['run', 'playground-pdf-agent', '--var', `url=${url}`, '--download-dir', dir], mock('pdf-agent-done'));
  expect(result.code, result.stderr).toBe(3);
  expect(result.stderr).toContain('done-unmet');
  expect(result.stdout).toBe('');
});

test('exits 3 with --no-llm and sends no request', async ({ scoop }) => {
  const { url, dir } = await setup(scoop);
  const result = await scoop.run(['run', 'playground-pdf-agent', '--var', `url=${url}`, '--download-dir', dir, '--no-llm'], mock('pdf-agent-link'));
  expect(result.code, result.stderr).toBe(3);
  expect(result.stderr).toContain('--no-llm');
  expect(result.stderr).not.toContain('agent: click');
});

test('prints no agent lines with --quiet', async ({ scoop }) => {
  const { url, dir } = await setup(scoop);
  const result = await scoop.run(['run', 'playground-pdf-agent', '--var', `url=${url}`, '--download-dir', dir, '--quiet'], mock('pdf-agent-link'));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).not.toContain('agent:');
});

async function formSetup(scoop: { writeRecipe(r: RecipeInput): Promise<string>; playground: { port: number } }, scope: 'site' | 'page' = 'site') {
  const recipe = JSON.parse(await readFile(FORM_AGENT_RECIPE, 'utf8')) as RecipeInput;
  if (scope === 'page') recipe.flows![0]!.steps[0]!.scope = 'page';
  await scoop.writeRecipe(recipe);
  return `http://127.0.0.1:${scoop.playground.port}/form`;
}

test('sends a form under site scope and ends on the thank-you banner', async ({ scoop }) => {
  const url = await formSetup(scoop);
  const result = await scoop.run(['run', 'playground-form-agent', '--var', `url=${url}`], mock('form-agent-send'));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/agent: click \[e\d+\] button "Send"/);
  expect(result.stderr).toMatch(/agent: send:0 ended: condition after 3 turns/);
});

test('undoes a click to another origin to the latest page and goes on', async ({ scoop }) => {
  const url = await formSetup(scoop);
  const result = await scoop.run(['run', 'playground-form-agent', '--var', `url=${url}`], mock('form-agent-wander'));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/agent: click \[e\d+\] link "Our partner shop"/);
  // The fill after the undo only matches a result that names the other origin as outside the scope.
  expect(result.stderr).toContain('back on the form; the name field');
  expect(result.stderr).toMatch(/agent: send:0 ended: condition after 4 turns/);
});

test('fails the same form under page scope because the submit is undone', async ({ scoop }) => {
  const url = await formSetup(scoop, 'page');
  const result = await scoop.run(['run', 'playground-form-agent', '--var', `url=${url}`], mock('form-agent-send'));
  expect(result.code, result.stderr).toBe(3);
  expect(result.stderr).toMatch(/agent: send:0 ended: gave-up/);
  expect(result.stderr).toContain('missing-required');
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`until timed out after ${timeoutMs} ms`);
}

async function checkoutSetup(scoop: { writeRecipe(r: RecipeInput): Promise<string>; playground: { port: number } }) {
  const recipe = JSON.parse(await readFile(CHECKOUT_AGENT_RECIPE, 'utf8')) as RecipeInput;
  await scoop.writeRecipe(recipe);
  return `http://127.0.0.1:${scoop.playground.port}/checkout`;
}

async function loginSetup(scoop: { writeRecipe(r: RecipeInput): Promise<string>; playground: { port: number } }) {
  const recipe = JSON.parse(await readFile(LOGIN_AGENT_RECIPE, 'utf8')) as RecipeInput;
  await scoop.writeRecipe(recipe);
  return `http://127.0.0.1:${scoop.playground.port}/login`;
}

test('stops before submit on checkout with --submit stop and ends ok with ready-to-submit', async ({ scoop }) => {
  const url = await checkoutSetup(scoop);
  const result = await scoop.run(['run', 'playground-checkout-agent', '--var', `url=${url}`, '--submit', 'stop'], mock('checkout-agent'));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/agent: would submit \[e\d+\] button "Place order"; stopped \(--submit stop\)/);
  expect(result.stderr).toMatch(/agent: checkout:0 ended: ready-to-submit after 1 turn/);
});

test('allows submit on checkout with --submit allow and reaches the condition', async ({ scoop }) => {
  const url = await checkoutSetup(scoop);
  const result = await scoop.run(['run', 'playground-checkout-agent', '--var', `url=${url}`, '--submit', 'allow'], mock('checkout-agent'));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/agent: click \[e\d+\] button "Place order"/);
  expect(result.stderr).toMatch(/agent: checkout:0 ended: condition/);
});

test('logs in with a secret password and the mock request log has no secret value', async ({ scoop }) => {
  const url = await loginSetup(scoop);
  const logFile = join(scoop.home, 'mock-log.jsonl');
  const scriptPath = join(scoop.home, 'login-script.json');
  await writeFile(
    scriptPath,
    JSON.stringify({
      log: logFile,
      responses: [
        { match: 'Username', reply: { action: 'fill', ref: 'e2', value: 'alice', reason: 'username' } },
        { match: 'Password', reply: { action: 'fill', ref: 'e3', value: '{password}', reason: 'password' } },
        { match: 'Sign in', reply: { action: 'click', ref: 'e4', reason: 'submit' } },
        { reply: { action: 'done', reason: 'done' }, repeat: true },
      ],
    }),
  );
  const secret = 'supersecret_token_12345';
  const result = await scoop.run(['run', 'playground-login-agent', '--no-guards', '--var', `url=${url}`, '--var', `password=${secret}`], {
    WEBSCOOP_LLM_MOCK: scriptPath,
    WEBSCOOP_LLM_ENDPOINT: undefined,
    WEBSCOOP_LLM_MODEL: undefined,
  });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/agent: login:0 ended: condition/);
  expect(existsSync(logFile)).toBe(true);
  const logContent = await readFile(logFile, 'utf8');
  expect(logContent).not.toContain(secret);
  expect(logContent).toContain('{password}');
});

test('pauses for confirm-submit under ask policy, fires hook, and continues on attention continue', async ({ scoop }) => {
  const url = await checkoutSetup(scoop);
  const hookLog = join(scoop.home, 'hook-attention.json');
  await writeFile(
    join(scoop.home, 'config.json'),
    `${JSON.stringify(
      e2eConfig({
        hooks: {
          'attention.needed': `cat > ${hookLog}`,
        },
      }),
    )}\n`,
  );
  const run = scoop.spawn(['run', 'playground-checkout-agent', '--var', `url=${url}`, '--guard-timeout', '600000'], mock('checkout-agent'));
  await until(() => existsSync(hookLog) && run.err().includes('wants to submit'));
  const hookData = JSON.parse(await readFile(hookLog, 'utf8'));
  expect(hookData).toMatchObject({
    event: 'attention.needed',
    reason: 'confirm-submit',
    label: 'checkout:0',
  });
  expect(hookData.line).toMatch(/button "Place order"/);
  const continueResult = await scoop.run(['attention', 'continue']);
  expect(continueResult.code).toBe(0);
  const result = await run.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/agent: click \[e\d+\] button "Place order"/);
  expect(result.stderr).toMatch(/agent: checkout:0 ended: condition/);
});
