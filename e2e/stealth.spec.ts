import { request as httpRequest, createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeInput } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { CHROME, e2eConfig, expect, hasDisplay, test } from './fixtures';

test.skip(!hasDisplay, 'the CLI needs WAYLAND_DISPLAY or DISPLAY');


const field = (name: string, value: string) => ({ name, type: 'text' as const, scope: 'page' as const, selectors: [{ strategy: 'css' as const, value, stability: 'medium' as const }] });

/** A page that prints what the browser reports as its timezone and language. */
const IDENTITY_PAGE = `<!doctype html><html><head><title>identity</title></head><body>
<p id="tz"></p><p id="lang"></p>
<script>
  document.getElementById('tz').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById('lang').textContent = navigator.language;
</script></body></html>`;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('the catalog recipe gives the same rows under Patchright with Chrome', async ({ scoop }) => {
  test.skip(!CHROME, 'Google Chrome is not installed');
  await writeFile(join(scoop.home, 'config.json'), `${JSON.stringify(e2eConfig({ browser: { driver: 'patchright' } }))}\n`);
  const result = await scoop.run(['run', 'playground-catalog']);
  expect(result.code, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as { title: string }[];
  expect(rows.map((r) => r.title)).toEqual(dataset.map((p) => p.title));
  expect(existsSync(join(scoop.home, 'profiles', 'playground-catalog@chrome', '.webscoop-browser.json'))).toBe(true);
});

test('the recipe timezone and locale reach the page', async ({ scoop }) => {
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(IDENTITY_PAGE));
  const port = await listen(server);
  try {
    const recipe: RecipeInput = {
      schemaVersion: 2,
      sequence: [{ extract: 'items' }],
      name: 'identity',
      url: `http://127.0.0.1:${port}/`,
      fields: [field('tz', '#tz'), field('lang', '#lang')],
      browser: { timezone: 'America/New_York', locale: 'en-US' },
    };
    await scoop.writeRecipe(recipe);
    const result = await scoop.run(['run', 'identity']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ _page: 1, _index: 0, tz: 'America/New_York', lang: 'en-US' }]);
    recipe.browser = { timezone: 'Asia/Tokyo', locale: 'ja-JP' };
    await scoop.writeRecipe(recipe);
    const tokyo = await scoop.run(['run', 'identity']);
    expect(JSON.parse(tokyo.stdout)).toEqual([{ _page: 1, _index: 0, tz: 'Asia/Tokyo', lang: 'ja-JP' }]);
  } finally {
    server.close();
  }
});

test('a run through --proxy reaches a host only the proxy knows', async ({ scoop }) => {
  const seen: string[] = [];
  const target = scoop.playground.port;
  // Forwards every request, whatever its host, to the playground.
  const proxy = createServer((req, res) => {
    const url = new URL(req.url!);
    seen.push(url.host);
    const upstream = httpRequest({ host: '127.0.0.1', port: target, path: `${url.pathname}${url.search}`, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${target}` } }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  proxy.on('connect', (req, socket) => {
    seen.push(req.url!);
    const upstream = netConnect(target, '127.0.0.1', () => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
    upstream.pipe(socket).pipe(upstream);
    upstream.on('error', () => socket.destroy());
  });
  const port = await listen(proxy);
  try {
    const recipe = structuredClone(scoop.recipe);
    recipe.name = 'via-proxy';
    recipe.url = recipe.url.replace('127.0.0.1', 'catalog.proxied.test');
    await scoop.writeRecipe(recipe);
    const result = await scoop.run(['run', 'via-proxy', '--proxy', `http://user:secret@127.0.0.1:${port}`]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(dataset.length);
    expect(seen.some((host) => host.startsWith('catalog.proxied.test'))).toBe(true);
    expect(result.stderr).toContain(`proxy http://***@127.0.0.1:${port}`);
    expect(result.stderr).not.toContain('secret');
  } finally {
    proxy.close();
  }
});
