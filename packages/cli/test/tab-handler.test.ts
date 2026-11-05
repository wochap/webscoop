import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeBrowser, h, type FakeInteractiveSession } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { handleTabAction, resolveTarget } from '../src/daemon/tab-handler';
import { Scheduler } from '../src/daemon/scheduler';
import type { CliIo } from '../src/context';

function testIo(): CliIo {
  return {
    cwd: tmpdir(),
    env: process.env as Record<string, string>,
    homedir: tmpdir(),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    terminal: false,
    onInterrupt: () => () => {},
    prompt: async () => null,
    createNotify: () => ({ notify: async () => {} }) as unknown as ReturnType<CliIo['createNotify']>,
    findBrowserPid: async () => null,
  } as unknown as CliIo;
}

describe('Target resolution and TabHandler', () => {
  it('resolves CSS, XPath, strategy prefixes, and outline refs with caching and stale errors', async () => {
    const fakeBrowser = new FakeBrowser({
      'https://shop.test/': {
        title: 'Shop Home',
        dom: h('html', {}, h('body', {},
          h('h1', { id: 'header' }, 'Welcome'),
          h('button', { id: 'btn', class: 'action-btn' }, 'Submit'),
          h('input', { type: 'text', id: 'search-input', value: '' }),
        )),
      },
    });

    const scheduler = new Scheduler();
    const session = (await fakeBrowser.open('/profile')) as FakeInteractiveSession;
    await session.goto('https://shop.test/', { timeoutMs: 1000 });

    const slot = scheduler.getOrCreateSlot('/profile', 'default');
    const tab = scheduler.registerInteractiveTab(slot, session, { url: 'https://shop.test/' });

    // 1. Ref before outline should fail with stale reference error
    await expect(resolveTarget(tab, 'e1')).rejects.toThrow(/stale reference e1/);

    // 2. Outline request populates tab.lastOutline
    const outlineRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.outline',
      tabId: tab.tabId,
    });
    expect(outlineRes.type).toBe('tab.outline');
    if (outlineRes.type === 'tab.outline') {
      expect(outlineRes.title).toBe('Shop Home');
      expect(outlineRes.outline).toContain('button "Submit"');
    }

    // 3. Target resolution by outline ref
    const resolvedRef = await resolveTarget(tab, 'e1');
    expect(resolvedRef.ref).toBeDefined();

    // 4. Target resolution by CSS
    const resolvedCss = await resolveTarget(tab, '#btn');
    expect(resolvedCss.ref).toBeDefined();

    // 5. Target resolution by explicit strategy prefix
    const resolvedPrefix = await resolveTarget(tab, 'css=#header');
    expect(resolvedPrefix.ref).toBeDefined();

    // 6. Target resolution by XPath
    const resolvedXpath = await resolveTarget(tab, '//button[@id="btn"]');
    expect(resolvedXpath.ref).toBeDefined();

    // 7. Unknown ref fails
    await expect(resolveTarget(tab, 'e999')).rejects.toThrow(/stale reference e999/);

    await scheduler.stop(false);
  });

  it('handles actions: click, fill, press, scroll, find, html, eval, and attend', async () => {
    const fakeBrowser = new FakeBrowser({
      'https://shop.test/': {
        title: 'Shop Home',
        dom: h('html', {}, h('body', {},
          h('h1', { id: 'title' }, 'Original Title'),
          h('input', { id: 'search-input', type: 'text', value: '' }),
          h('button', { id: 'submit-btn' }, 'Search'),
        )),
      },
      'https://shop.test/results': {
        title: 'Search Results',
        dom: h('html', {}, h('body', {}, h('div', { id: 'results' }, 'Found items'))),
      },
    });

    const scheduler = new Scheduler();
    const session = (await fakeBrowser.open('/profile')) as FakeInteractiveSession;
    await session.goto('https://shop.test/', { timeoutMs: 1000 });

    const slot = scheduler.getOrCreateSlot('/profile', 'default');
    const tab = scheduler.registerInteractiveTab(slot, session, { url: 'https://shop.test/' });

    // html
    const htmlRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.html',
      tabId: tab.tabId,
      target: '#title',
    });
    expect(htmlRes).toEqual({
      type: 'tab.html',
      tabId: tab.tabId,
      html: 'Original Title',
    });

    // fill
    const fillRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.fill',
      tabId: tab.tabId,
      target: '#search-input',
      value: 'headphones',
    });
    expect(fillRes.type).toBe('tab.page');

    // press
    const pressRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.press',
      tabId: tab.tabId,
      key: 'Enter',
      target: '#search-input',
    });
    expect(pressRes.type).toBe('tab.page');

    // scroll
    const scrollRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.scroll',
      tabId: tab.tabId,
      direction: 'down',
    });
    expect(scrollRes.type).toBe('tab.page');

    // eval
    session.nextEvaluateResult = { key: 'value', count: 123 };
    const evalRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.eval',
      tabId: tab.tabId,
      expression: '({ key: "value", count: 123 })',
    });
    expect(evalRes).toEqual({
      type: 'tab.eval',
      tabId: tab.tabId,
      result: { key: 'value', count: 123 },
    });

    // find
    const findRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.find',
      tabId: tab.tabId,
      text: 'search',
    });
    expect(findRes.type).toBe('tab.find');
    if (findRes.type === 'tab.find') {
      expect(findRes.matches.length).toBeGreaterThan(0);
    }

    // goto and back
    const gotoRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.goto',
      tabId: tab.tabId,
      url: 'https://shop.test/results',
    });
    expect(gotoRes.type).toBe('tab.page');
    if (gotoRes.type === 'tab.page') {
      expect(gotoRes.url).toBe('https://shop.test/results');
    }

    const backRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.back',
      tabId: tab.tabId,
    });
    expect(backRes.type).toBe('tab.page');

    // attend
    const attendRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.attend',
      tabId: tab.tabId,
    });
    expect(attendRes.type).toBe('tab.page');

    // close
    const closeRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.close',
      tabId: tab.tabId,
    });
    expect(closeRes).toEqual({
      type: 'tab.closed',
      closed: [tab.tabId],
    });

    await scheduler.stop(false);
  });

  it('routes tab.download directly to client destination path and creates parent dirs', async () => {
    const tmpSubdir = join(tmpdir(), `webscoop-dl-test-${Date.now()}`, 'nested', 'folder');
    const outFilePath = join(tmpSubdir, 'track01.mp3');

    const fakeBrowser = new FakeBrowser({
      'https://music.test/': {
        title: 'Music Home',
        dom: h('html', {}, h('body', {},
          h('button', { id: 'download-btn' }, 'Download'),
        )),
        on: {
          click: () => ({ download: { url: 'https://music.test/sample.mp3', name: 'sample.mp3', bytes: 1024, data: Buffer.from('fake mp3 audio content') } }),
        },
      },
    });

    const scheduler = new Scheduler();
    const session = (await fakeBrowser.open('/profile')) as FakeInteractiveSession;
    session.dir = tmpdir();
    await session.goto('https://music.test/', { timeoutMs: 1000 });
    await writeFile(join(tmpdir(), 'sample.mp3'), 'fake mp3 audio content');

    const slot = scheduler.getOrCreateSlot('/profile', 'default');
    const tab = scheduler.registerInteractiveTab(slot, session, { url: 'https://music.test/' });

    const dlRes = await handleTabAction(scheduler, testIo(), {
      type: 'tab.download',
      tabId: tab.tabId,
      target: '#download-btn',
      outPath: outFilePath,
    });

    expect(dlRes.type).toBe('tab.download');
    if (dlRes.type === 'tab.download') {
      expect(dlRes.file).toBe(outFilePath);
      expect(dlRes.bytes).toBeGreaterThan(0);
    }

    // Verify file actually exists at outFilePath
    const content = await readFile(outFilePath, 'utf8');
    expect(content).toBe('fake mp3 audio content');

    // Cleanup
    await rm(join(tmpdir(), `webscoop-dl-test-${Date.now()}`), { recursive: true, force: true }).catch(() => {});
    await scheduler.stop(false);
  });
});
