import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { sharedDaemon, tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };

describe('End-to-End Agent Tab Enhancements Integration Test (Task 4.1)', () => {
  it('demonstrates multi-tab scraping with labels, scoped outlines, batching, getters, and routing', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'profiles'), { recursive: true });

    const fakeBrowser = new FakeBrowser({
      'https://music.test/calm': {
        title: 'Calm Music',
        dom: h('html', {}, h('body', {},
          h('header', {}, h('h1', {}, 'Calm Tracks')),
          h('div', { id: 'catalog' },
            h('article', { class: 'track-card' },
              h('a', { id: 'track-1', href: '/download/calm1.mp3', 'data-duration': '3:45' }, 'Ocean Waves'),
              h('button', { id: 'play-1', 'aria-expanded': 'false' }, 'Preview'),
              h('input', { id: 'notes-1', type: 'text', placeholder: 'Add track notes...', value: '' }),
            ),
            h('article', { class: 'track-card' },
              h('a', { id: 'track-2', href: '/download/calm2.mp3', 'data-duration': '4:12' }, 'Forest Rain'),
              h('button', { id: 'play-2', 'aria-expanded': 'false' }, 'Preview'),
            ),
          ),
          h('footer', {}, h('p', {}, 'Copyright 2026 Music Test')),
        )),
      },
      'https://music.test/upbeat': {
        title: 'Upbeat Music',
        dom: h('html', {}, h('body', {},
          h('header', {}, h('h1', {}, 'Upbeat Tracks')),
          h('div', { id: 'catalog' },
            h('article', { class: 'track-card' },
              h('a', { id: 'track-3', href: '/download/upbeat1.mp3', 'data-duration': '2:30' }, 'Summer Groove'),
              h('button', { id: 'play-3' }, 'Preview'),
            ),
          ),
        )),
      },
    });

    const daemon = sharedDaemon();

    // 1. Open two tabs with memorable labels in parallel
    const ioOpen1 = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: fakeBrowser, daemon });
    const codeOpen1 = await main(['tab', 'open', 'https://music.test/calm', '--label', 'calm', '--json'], ioOpen1);
    expect(codeOpen1).toBe(ExitCode.Ok);
    const tab1 = JSON.parse(ioOpen1.out());
    expect(tab1.label).toBe('calm');

    const ioOpen2 = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: fakeBrowser, daemon });
    const codeOpen2 = await main(['tab', 'open', 'https://music.test/upbeat', '--label', 'upbeat', '--json'], ioOpen2);
    expect(codeOpen2).toBe(ExitCode.Ok);
    const tab2 = JSON.parse(ioOpen2.out());
    expect(tab2.label).toBe('upbeat');

    // 2. List tabs and verify both labels appear
    const ioTabs = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeTabs = await main(['tabs', '--json'], ioTabs);
    expect(codeTabs).toBe(ExitCode.Ok);
    const tabsList = JSON.parse(ioTabs.out());
    expect(tabsList).toHaveLength(2);
    expect(tabsList.some((t: any) => t.label === 'calm')).toBe(true);
    expect(tabsList.some((t: any) => t.label === 'upbeat')).toBe(true);

    // 3. Inspect page structure on "calm" using scoped, indented outline with -i and -s
    const ioOutline = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeOutline = await main(['tab', 'outline', 'calm', '-i', '-s', '#catalog'], ioOutline);
    expect(codeOutline).toBe(ExitCode.Ok);
    const outline = ioOutline.out();
    expect(outline).toContain('link "Ocean Waves"');
    expect(outline).toContain('button "Preview" aria-expanded="false"');
    expect(outline).toContain('placeholder="Add track notes..."');
    // Footer text should be excluded because outline is scoped to #catalog
    expect(outline).not.toContain('Copyright');

    // 4. Extract data using fast getters (get attr, text, value) on "calm"
    const ioGetAttr = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tab', 'get', 'attr', 'calm', '#track-1', 'data-duration'], ioGetAttr);
    expect(ioGetAttr.out().trim()).toBe('3:45');

    const ioGetHref = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tab', 'get', 'attr', 'calm', '#track-1', 'href'], ioGetHref);
    expect(ioGetHref.out().trim()).toBe('/download/calm1.mp3');

    const ioGetText = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tab', 'get', 'text', 'upbeat', '#track-3'], ioGetText);
    expect(ioGetText.out().trim()).toBe('Summer Groove');

    // 5. In-daemon command batching on "calm"
    const ioBatch = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeBatch = await main([
      'tab', 'batch', 'calm',
      'fill #notes-1 "Relaxing ambient sound"',
      'get value #notes-1',
    ], ioBatch);
    expect(codeBatch).toBe(ExitCode.Ok);
    expect(ioBatch.out()).toContain('Relaxing ambient sound');

    // 6. Network route aborting and unrouting
    const ioRoute = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeRoute = await main(['tab', 'route', 'calm', '*analytics.js*', '--abort'], ioRoute);
    expect(codeRoute).toBe(ExitCode.Ok);

    const ioUnroute = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeUnroute = await main(['tab', 'unroute', 'calm', '*analytics.js*'], ioUnroute);
    expect(codeUnroute).toBe(ExitCode.Ok);

    // 7. Semantic wait
    const ioWait = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeWait = await main(['tab', 'wait', 'calm', '20'], ioWait);
    expect(codeWait).toBe(ExitCode.Ok);

    // 8. Close both tabs by label
    const ioClose1 = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tab', 'close', 'calm'], ioClose1);

    const ioClose2 = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tab', 'close', 'upbeat'], ioClose2);

    const ioTabsAfter = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tabs', '--json'], ioTabsAfter);
    expect(JSON.parse(ioTabsAfter.out())).toHaveLength(0);
  });
});
