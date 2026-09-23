import { existsSync } from 'node:fs';
import { expect, test } from './fixtures';

test.describe.configure({ mode: 'serial' });

let seen: { home: string; url: string } | undefined;

test('fixture provides an isolated home and a running playground', async ({ scoop }) => {
  expect(existsSync(scoop.recipePath)).toBe(true);
  expect((await fetch(`${scoop.playground.url}/catalog`)).status).toBe(200);
  seen = { home: scoop.home, url: scoop.playground.url };
});

test('fixture tears down the server and the temp dir', async () => {
  expect(seen).toBeDefined();
  expect(existsSync(seen!.home)).toBe(false);
  await expect(fetch(`${seen!.url}/catalog`)).rejects.toThrow();
});
