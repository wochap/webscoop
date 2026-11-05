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
});
