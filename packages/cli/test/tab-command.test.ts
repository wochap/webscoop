import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { sharedDaemon, tempDir, testIo } from './helpers';
import { formatStatus } from '../src/commands/daemon';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };

describe('webscoop tab and tabs CLI commands', () => {
  it('opens tab, inspects outline, clicks, evals, and closes via CLI commands', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'profiles'), { recursive: true });

    const fakeBrowser = new FakeBrowser({
      'https://example.test/': {
        title: 'Example Page',
        dom: h('html', {}, h('body', {},
          h('h1', { id: 'hdr' }, 'Hello Agent'),
          h('button', { id: 'btn' }, 'Click Me'),
          h('input', { id: 'field', type: 'text', value: '' }),
        )),
      },
    });

    const daemon = sharedDaemon();
    const io = testIo({
      env: { ...DISPLAY, WEBSCOOP_HOME: dir },
      browser: fakeBrowser,
      daemon,
    });

    // 1. webscoop tab open "https://example.test/" --json
    const codeOpen = await main(['tab', 'open', 'https://example.test/', '--json'], io);
    expect(codeOpen).toBe(ExitCode.Ok);
    const opened = JSON.parse(io.out());
    expect(opened.tabId).toBe('tab_1');
    expect(opened.url).toBe('https://example.test/');

    // 2. webscoop tabs --json
    const ioTabs = testIo({
      env: { ...DISPLAY, WEBSCOOP_HOME: dir },
      daemon,
    });

    const codeTabs = await main(['tabs', '--json'], ioTabs);
    expect(codeTabs).toBe(ExitCode.Ok);
    const tabsList = JSON.parse(ioTabs.out());
    expect(Array.isArray(tabsList)).toBe(true);
    expect(tabsList.length).toBe(1);
    expect(tabsList[0].tabId).toBe('tab_1');

    // 3. webscoop tab outline tab_1
    const ioOutline = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeOutline = await main(['tab', 'outline', 'tab_1'], ioOutline);
    expect(codeOutline).toBe(ExitCode.Ok);
    expect(ioOutline.out()).toContain('URL: https://example.test/');
    expect(ioOutline.out()).toContain('button "Click Me"');

    // 4. webscoop tab click tab_1 e1
    const ioClick = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeClick = await main(['tab', 'click', 'tab_1', 'e1', '--json'], ioClick);
    expect(codeClick).toBe(ExitCode.Ok);
    const clickJson = JSON.parse(ioClick.out());
    expect(clickJson.tabId).toBe('tab_1');

    // 5. webscoop tab eval tab_1 "1 + 1" --json
    const ioEval = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeEval = await main(['tab', 'eval', 'tab_1', '1 + 1', '--json'], ioEval);
    expect(codeEval).toBe(ExitCode.Ok);

    // 6. webscoop tab close tab_1 --json
    const ioClose = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeClose = await main(['tab', 'close', 'tab_1', '--json'], ioClose);
    expect(codeClose).toBe(ExitCode.Ok);
    const closeJson = JSON.parse(ioClose.out());
    expect(closeJson.closed).toEqual(['tab_1']);
  });

  it('formats open tabs in daemon status', () => {
    const formatted = formatStatus({
      pid: 1234,
      version: '0.11.0',
      browsers: [
        {
          profile: 'default',
          profileDir: '/profiles/default',
          pid: 5678,
          running: [],
          queued: [],
          attention: null,
          tabs: [
            {
              tabId: 'tab_1',
              profile: 'default',
              url: 'https://incompetech.com/',
              title: 'Royalty Free Music',
              isPopup: false,
            },
            {
              tabId: 'tab_2',
              profile: 'default',
              url: 'https://login.test/',
              title: 'Login',
              isPopup: true,
              openerTabId: 'tab_1',
            },
          ],
        },
      ],
    });

    expect(formatted).toContain('daemon running: pid 1234');
    expect(formatted).toContain('tab_1: https://incompetech.com/ "Royalty Free Music"');
    expect(formatted).toContain('tab_2 (popup): https://login.test/ "Login"');
  });

  it('provides CLI help and executes enhanced subcommands: label, outline filters, get, batch, wait, route (Task 3.1)', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'profiles'), { recursive: true });

    // 1. Verify CLI help for tab subcommands
    const ioHelp = testIo({});
    const codeHelp = await main(['tab', '--help'], ioHelp);
    expect(codeHelp).toBe(ExitCode.Ok);
    const helpText = ioHelp.out();
    expect(helpText).toContain('get');
    expect(helpText).toContain('batch');
    expect(helpText).toContain('wait');
    expect(helpText).toContain('route');
    expect(helpText).toContain('unroute');

    const fakeBrowser = new FakeBrowser({
      'https://catalog.test/': {
        title: 'Catalog',
        dom: h('html', {}, h('body', {},
          h('div', { id: 'results' },
            h('h2', {}, 'Items'),
            h('a', { id: 'item1', href: '/item/1', 'data-sku': 'SKU-001' }, 'First Item'),
            h('input', { id: 'search-box', type: 'text', value: 'shoes' }),
            h('button', { id: 'buy-btn' }, 'Buy Now'),
          ),
        )),
      },
    });

    const daemon = sharedDaemon();
    const io = testIo({
      env: { ...DISPLAY, WEBSCOOP_HOME: dir },
      browser: fakeBrowser,
      daemon,
    });

    // 2. Open tab with --label
    const codeOpen = await main(['tab', 'open', 'https://catalog.test/', '--label', 'store', '--json'], io);
    expect(codeOpen).toBe(ExitCode.Ok);
    const opened = JSON.parse(io.out());
    expect(opened.tabId).toBe('tab_1');
    expect(opened.label).toBe('store');

    // 3. Outline with filters (-i, -s) using label identifier
    const ioOutline = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeOutline = await main(['tab', 'outline', 'store', '-i', '-s', '#results'], ioOutline);
    expect(codeOutline).toBe(ExitCode.Ok);
    const outlineOut = ioOutline.out();
    expect(outlineOut).toContain('link "First Item"');
    expect(outlineOut).toContain('button "Buy Now"');
    // Non-interactive heading 'Items' should be filtered out by -i
    expect(outlineOut).not.toContain('heading "Items"');

    // 4. Tab get: text, attr, value using label
    const ioGetText = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tab', 'get', 'text', 'store', '#item1'], ioGetText);
    expect(ioGetText.out().trim()).toBe('First Item');

    const ioGetAttr = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tab', 'get', 'attr', 'store', '#item1', 'data-sku'], ioGetAttr);
    expect(ioGetAttr.out().trim()).toBe('SKU-001');

    const ioGetVal = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    await main(['tab', 'get', 'value', 'store', '#search-box'], ioGetVal);
    expect(ioGetVal.out().trim()).toBe('shoes');

    // 5. Tab wait using label
    const ioWait = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeWait = await main(['tab', 'wait', 'store', '10'], ioWait);
    expect(codeWait).toBe(ExitCode.Ok);

    // 6. Tab route and unroute using label
    const ioRoute = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeRoute = await main(['tab', 'route', 'store', '*.ads.*', '--abort'], ioRoute);
    expect(codeRoute).toBe(ExitCode.Ok);

    const ioUnroute = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeUnroute = await main(['tab', 'unroute', 'store', '*.ads.*'], ioUnroute);
    expect(codeUnroute).toBe(ExitCode.Ok);

    // 7. Tab batch using label
    const ioBatch = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeBatch = await main(['tab', 'batch', 'store', 'click #buy-btn', 'get text #buy-btn'], ioBatch);
    expect(codeBatch).toBe(ExitCode.Ok);
    expect(ioBatch.out()).toContain('Buy Now');

    // 8. Close by label
    const ioClose = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, daemon });
    const codeClose = await main(['tab', 'close', 'store', '--json'], ioClose);
    expect(codeClose).toBe(ExitCode.Ok);
    const closeJson = JSON.parse(ioClose.out());
    expect(closeJson.closed).toEqual(['tab_1']);
  });
});
