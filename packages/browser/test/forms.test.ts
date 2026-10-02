import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FillUnresolvedError, type SelectorCandidate, type Session } from '@webscoop/core';
import { startPlayground, type Playground } from '@webscoop/playground';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightBrowser } from '../src';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
const css = (value: string): SelectorCandidate => ({ strategy: 'css', value, stability: 'medium' });

describe.skipIf(!hasDisplay).each([false, true])('fill by element kind on the forms page (humanize %s)', (humanize) => {
  let playground: Playground;
  let dir: string;
  let session: Session;
  let files: { a: string; b: string };

  beforeAll(async () => {
    playground = await startPlayground({ port: 0 });
    dir = await mkdtemp(join(tmpdir(), 'webscoop-forms-'));
    files = { a: join(dir, 'a.txt'), b: join(dir, 'clip.bin') };
    await writeFile(files.a, 'twelve bytes');
    await writeFile(files.b, Buffer.alloc(300));
    session = await new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined }).open(join(dir, 'profile'), humanize ? { humanize: true } : {});
  });

  afterAll(async () => {
    await session?.close();
    await playground?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const fill = async (selector: string, value: string, opts?: Parameters<Session['fill']>[2]) => {
    const [ref] = await session.resolve(css(selector));
    expect(ref, selector).toBeDefined();
    await session.fill(ref!, value, opts);
  };

  it('sets every kind and the echo matches', { timeout: 120_000 }, async () => {
    await session.goto(`${playground.url}/forms`, { timeoutMs: 10_000 });
    await fill('#text', 'Ada Lovelace');
    await fill('#email', 'ada@example.test');
    await fill('#password', 'hunter2');
    await fill('#textarea', 'line one');
    await fill('#select', 'Peru');
    await fill('#multiselect', 'Spanish\nqu');
    await fill('#checkbox', 'true');
    await fill('#checkbox', 'true');
    await fill('#radio-pro', 'true');
    await fill('#switch', 'true');
    await fill('#date', '1815-12-10');
    await fill('#controlled', 'Ada');
    await fill('#combobox', 'Lima', { timeoutMs: 5000 });
    await fill('#otp-0', '482913');
    await fill('#notes', 'some notes');
    await fill('#shadow', 'in the shadow');
    await fill('#file', `${files.a}:${files.b}`);
    await fill('#chooser-button', '', { files: [files.a] });
    await fill('#dropzone', '', { files: [files.a, files.b] });
    // The controlled input keeps the value across renders.
    await new Promise((r) => setTimeout(r, 150));
    const page = (session as unknown as { page: import('playwright').Page }).page;
    expect(await page.inputValue('#controlled')).toBe('Ada');

    const [submit] = await session.resolve(css('#submit'));
    const before = await session.url();
    await session.click(submit!);
    await session.settle({ timeoutMs: 10_000, previousUrl: before });
    const [echo] = await session.resolve(css('#echo'));
    const values = JSON.parse(await session.read(echo!, { mode: 'text' }));
    expect(values).toEqual({
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
      dropzone: [
        { name: 'a.txt', size: 12 },
        { name: 'clip.bin', size: 300 },
      ],
    });
  });

  it('counts a missing combobox option or file chooser as an unresolved target, and rejects a radio set to false', async () => {
    await session.goto(`${playground.url}/forms`, { timeoutMs: 10_000 });
    await expect(fill('#combobox', 'Quito', { timeoutMs: 500 })).rejects.toBeInstanceOf(FillUnresolvedError);
    await expect(fill('#switch', '', { files: [files.a] })).rejects.toBeInstanceOf(FillUnresolvedError);
    await expect(fill('#radio-free', 'false')).rejects.toThrow(/radio cannot be set to false/);
  });
});
