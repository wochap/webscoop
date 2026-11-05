import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { SharedBrowser } from '@webscoop/browser';
import { Scheduler } from '../src/daemon/scheduler';
import { handleTabAction } from '../src/daemon/tab-handler';
import type { CliIo } from '../src/context';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

describe.skipIf(!hasDisplay)('End-to-End Agent Tab Control (concurrent tabs & downloads)', () => {
  let server: Server;
  let serverUrl: string;
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'agent-tab-work-'));

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname === '/music.html') {
        const feel = url.searchParams.get('feel') ?? 'default';
        const title = feel === 'calming' ? 'Calming Ambient Track' : 'High Energy Driving Track';
        const bpm = feel === 'calming' ? 72 : 138;
        const dlPath = feel === 'calming' ? '/download/calm.mp3' : '/download/driving.mp3';

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Music Archive - ${feel}</title></head>
<body>
  <h1 id="track-title">${title}</h1>
  <div id="metadata" data-genre="contemporary" data-feel="${feel}" data-bpm="${bpm}"></div>
  <a id="download-link" href="${dlPath}" download>Download Song</a>
</body>
</html>`);
        return;
      }

      if (url.pathname === '/download/calm.mp3') {
        const data = Buffer.from('CALM_AUDIO_DATA_BYTES_12345');
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': 'attachment; filename="calm.mp3"',
          'Content-Length': data.length,
        });
        res.end(data);
        return;
      }

      if (url.pathname === '/download/driving.mp3') {
        const data = Buffer.from('DRIVING_AUDIO_DATA_BYTES_987654321');
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': 'attachment; filename="driving.mp3"',
          'Content-Length': data.length,
        });
        res.end(data);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server?.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it('drives two concurrent tabs, extracts metadata via eval, and downloads into separate directories', async () => {
    const scheduler = new Scheduler();

    const io: CliIo = {
      cwd: workDir,
      env: {
        ...process.env,
        WEBSCOOP_CHROMIUM: process.env.WEBSCOOP_CHROMIUM || '/run/current-system/sw/bin/google-chrome',
      } as Record<string, string>,
      homedir: workDir,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      terminal: false,
      onInterrupt: () => () => {},
      prompt: async () => null,
      createNotify: () => ({ notify: async () => {} }) as unknown as ReturnType<CliIo['createNotify']>,
      findBrowserPid: async () => null,
      async chromium() {
        return {
          driver: 'playwright' as const,
          channel: 'chromium' as const,
          id: '',
          path: process.env.WEBSCOOP_CHROMIUM || '/run/current-system/sw/bin/google-chrome',
          source: 'override' as const,
          installed: true,
          version: 'Chromium 1',
        };
      },
      async launchBrowser(_config: unknown, _env: unknown, _browser: unknown, pDir: string, opts?: { bypassCSP?: boolean }) {
        return SharedBrowser.launch(
          {
            driver: 'playwright',
            executablePath: process.env.WEBSCOOP_CHROMIUM || '/run/current-system/sw/bin/google-chrome',
          },
          pDir,
          opts,
        );
      },
    } as unknown as CliIo;

    // 1. Open Tab 1 for Calming music
    const openTab1Res = await handleTabAction(scheduler, io, {
      type: 'tab.open',
      url: `${serverUrl}/music.html?feel=calming`,
      profile: 'agent-e2e',
      visual: true,
      cwd: workDir,
      env: io.env as Record<string, string>,
    });
    expect(openTab1Res.type).toBe('tab.opened');
    if (openTab1Res.type !== 'tab.opened') return;
    const tab1Id = openTab1Res.tab.tabId;

    // 2. Open Tab 2 for Driving music concurrently
    const openTab2Res = await handleTabAction(scheduler, io, {
      type: 'tab.open',
      url: `${serverUrl}/music.html?feel=driving`,
      profile: 'agent-e2e',
      visual: true,
      cwd: workDir,
      env: io.env as Record<string, string>,
    });
    expect(openTab2Res.type).toBe('tab.opened');
    if (openTab2Res.type !== 'tab.opened') return;
    const tab2Id = openTab2Res.tab.tabId;

    expect(tab1Id).not.toBe(tab2Id);

    // 3. Verify both tabs are open simultaneously
    const listRes = await handleTabAction(scheduler, io, {
      type: 'tab.list',
      profile: 'agent-e2e',
    });
    expect(listRes.type).toBe('tab.list');
    if (listRes.type !== 'tab.list') return;
    const openTabs = listRes.tabs;
    expect(openTabs.length).toBe(2);

    // 4. Extract metadata via eval from Tab 1
    const evalTab1 = await handleTabAction(scheduler, io, {
      type: 'tab.eval',
      tabId: tab1Id,
      expression: `({
        title: document.getElementById('track-title').innerText,
        feel: document.getElementById('metadata').dataset.feel,
        bpm: Number(document.getElementById('metadata').dataset.bpm)
      })`,
    });
    expect(evalTab1.type).toBe('tab.eval');
    if (evalTab1.type !== 'tab.eval') return;
    expect(evalTab1.result).toEqual({
      title: 'Calming Ambient Track',
      feel: 'calming',
      bpm: 72,
    });

    // 5. Extract metadata via eval from Tab 2
    const evalTab2 = await handleTabAction(scheduler, io, {
      type: 'tab.eval',
      tabId: tab2Id,
      expression: `({
        title: document.getElementById('track-title').innerText,
        feel: document.getElementById('metadata').dataset.feel,
        bpm: Number(document.getElementById('metadata').dataset.bpm)
      })`,
    });
    expect(evalTab2.type).toBe('tab.eval');
    if (evalTab2.type !== 'tab.eval') return;
    expect(evalTab2.result).toEqual({
      title: 'High Energy Driving Track',
      feel: 'driving',
      bpm: 138,
    });

    // 6. Download track from Tab 1 into ./calm/track01.mp3
    const calmDest = join(workDir, 'calm', 'track01.mp3');
    const dlTab1 = await handleTabAction(scheduler, io, {
      type: 'tab.download',
      tabId: tab1Id,
      target: '#download-link',
      outPath: calmDest,
      visual: true,
    });
    expect(dlTab1.type).toBe('tab.download');
    if (dlTab1.type !== 'tab.download') return;
    expect(dlTab1.file).toBe(calmDest);
    expect(dlTab1.bytes).toBeGreaterThan(0);

    const calmContent = await readFile(calmDest, 'utf8');
    expect(calmContent).toBe('CALM_AUDIO_DATA_BYTES_12345');

    // 7. Download track from Tab 2 into ./driving/track01.mp3
    const drivingDest = join(workDir, 'driving', 'track01.mp3');
    const dlTab2 = await handleTabAction(scheduler, io, {
      type: 'tab.download',
      tabId: tab2Id,
      target: '#download-link',
      outPath: drivingDest,
      visual: true,
    });
    expect(dlTab2.type).toBe('tab.download');
    if (dlTab2.type !== 'tab.download') return;
    expect(dlTab2.file).toBe(drivingDest);
    expect(dlTab2.bytes).toBeGreaterThan(0);

    const drivingContent = await readFile(drivingDest, 'utf8');
    expect(drivingContent).toBe('DRIVING_AUDIO_DATA_BYTES_987654321');

    // 8. Close both tabs
    await handleTabAction(scheduler, io, { type: 'tab.close', tabId: tab1Id });
    await handleTabAction(scheduler, io, { type: 'tab.close', tabId: tab2Id });

    const finalList = await handleTabAction(scheduler, io, { type: 'tab.list', profile: 'agent-e2e' });
    expect(finalList.type).toBe('tab.list');
    if (finalList.type !== 'tab.list') return;
    expect(finalList.tabs.length).toBe(0);

    await scheduler.stop(true);
  });
});
