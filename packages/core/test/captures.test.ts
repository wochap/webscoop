import { describe, expect, it } from 'vitest';
import { CaptureSet, loadRecipe, recordEvents, RunEmitter, runRecipe, type CaptureRow, type RecipeInput } from '../src';
import { FakeBrowser, h, type FakeRequest } from '../src/testing';

const PAGE = 'https://learn.test/v/42';
const PLAYLIST = 'https://vz-aa93bf80-5cb.b-cdn.net/0999851b/playlist.m3u8';
const VARIANT = 'https://vz-aa93bf80-5cb.b-cdn.net/0999851b/1080p/video.m3u8';
const PLAYER = 'https://iframe.mediadelivery.net/embed/1/0999851b';

const capture = (name: string, match: string, extra: { count?: number; optional?: boolean } = {}) => ({ name, match, count: extra.count ?? 1, optional: extra.optional ?? false });

function feed(set: CaptureSet) {
  let n = 0;
  return {
    request(url: string, frameUrl: string | null = PLAYER): string {
      const id = `r${++n}`;
      set.handle({ type: 'request', id, url, method: 'GET', frameUrl, window: 'main', resourceType: 'xhr', at: 0 });
      return id;
    },
    respond(id: string, status = 200, mime = 'application/vnd.apple.mpegurl'): void {
      set.handle({ type: 'update', id, status, mime, failed: false });
    },
    fail(id: string): void {
      set.handle({ type: 'update', id, status: null, mime: null, failed: true });
    },
  };
}

describe('CaptureSet', () => {
  const setup = (captures: ReturnType<typeof capture>[], page = 1) => {
    const matched: { capture: string; row: CaptureRow }[] = [];
    const set = new CaptureSet(captures, { page: () => page, onMatched: (c, row) => matched.push({ capture: c, row: { ...row } }) });
    return { set, matched, ...feed(set) };
  };

  it('keeps one row per URL, emitted when its first request gets a response', () => {
    const { set, matched, request, respond } = setup([capture('videos', '/playlist\\.m3u8(\\?|$)')]);
    const first = request(PLAYLIST);
    expect(matched).toHaveLength(0);
    const second = request(PLAYLIST);
    respond(first);
    respond(second, 304, 'text/plain');
    request(PLAYLIST);
    expect(matched).toEqual([{ capture: 'videos', row: { url: PLAYLIST, method: 'GET', status: 200, mime: 'application/vnd.apple.mpegurl', frame: PLAYER, _page: 1, _index: 0 } }]);
    expect(set.report()).toEqual([{ name: 'videos', count: 1, optional: false, rows: 1, status: 'ok' }]);
  });

  it('indexes rows in request order and emits them in completion order', () => {
    const { matched, request, respond, fail } = setup([capture('streams', '\\.m3u8(\\?|$)', { count: 2 })]);
    const a = request(PLAYLIST);
    const b = request(VARIANT);
    respond(b);
    fail(a);
    expect(matched.map((m) => [m.row.url, m.row._index, m.row.status])).toEqual([
      [VARIANT, 1, 200],
      [PLAYLIST, 0, null],
    ]);
  });

  it('completes rows without a response when the run ends', () => {
    const { set, matched, request } = setup([capture('videos', 'm3u8')]);
    request(PLAYLIST);
    set.finish();
    expect(matched[0]!.row).toMatchObject({ status: null, mime: null });
    set.finish();
    expect(matched).toHaveLength(1);
  });

  it('settles as soon as the count is reached, and at once when already full or only optional', async () => {
    const { set, request } = setup([capture('streams', '\\.m3u8', { count: 2 }), capture('subs', '\\.vtt', { optional: true })]);
    request(PLAYLIST);
    const started = Date.now();
    const settling = set.settle(5_000);
    setTimeout(() => request(VARIANT), 20);
    await settling;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(set.report().map((r) => r.status)).toEqual(['ok', 'missing']);
    await set.settle(5_000);
  });

  it('settles at the deadline when a capture falls short', async () => {
    const { set } = setup([capture('videos', 'm3u8')]);
    const started = Date.now();
    await set.settle(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(set.report()[0]!.status).toBe('missing');
  });
});

function recipe(captures: unknown[]): RecipeInput {
  return { schemaVersion: 2, name: 'lesson-video', url: PAGE, captures } as RecipeInput;
}

function browserWith(requests: FakeRequest[]) {
  return new FakeBrowser({ [PAGE]: { dom: h('html', {}, h('body', {}, h('h1', {}, 'Lesson 42'))), requests } });
}

describe('Runner captures', () => {
  it('counts a request made while the page loads', async () => {
    const browser = browserWith([{ url: PLAYLIST, frameUrl: PLAYER, mime: 'application/vnd.apple.mpegurl' }]);
    const emitter = new RunEmitter();
    const log = recordEvents(emitter);
    const result = await runRecipe({ recipe: loadRecipe(JSON.stringify(recipe([{ name: 'videos', match: '/playlist\\.m3u8(\\?|$)' }]))), browser, profileDir: '/p', emitter });
    expect(result.ok).toBe(true);
    expect(log.of('capture.matched')).toEqual([{ capture: 'videos', row: { url: PLAYLIST, method: 'GET', status: 200, mime: 'application/vnd.apple.mpegurl', frame: PLAYER, _page: 1, _index: 0 } }]);
    expect(result.report.captures).toEqual([{ name: 'videos', count: 1, optional: false, rows: 1, status: 'ok' }]);
  });

  it('waits for a playlist that arrives after the sequence', async () => {
    const browser = browserWith([{ url: PLAYLIST, afterMs: 150 }]);
    const emitter = new RunEmitter();
    const log = recordEvents(emitter);
    const result = await runRecipe({ recipe: loadRecipe(JSON.stringify(recipe([{ name: 'videos', match: 'playlist' }]))), browser, profileDir: '/p', emitter, timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(log.of('capture.matched')).toHaveLength(1);
    expect(log.names().indexOf('capture.matched')).toBeLessThan(log.names().indexOf('run.done'));
    expect(browser.openSessions).toBe(0);
  });

  it('fails with missing-required naming a required capture that never matches', async () => {
    const browser = browserWith([]);
    const result = await runRecipe({ recipe: loadRecipe(JSON.stringify(recipe([{ name: 'videos', match: 'playlist' }]))), browser, profileDir: '/p', timeoutMs: 100 });
    expect(result).toMatchObject({ ok: false, reason: 'missing-required', fields: ['videos'] });
    if (result.ok) return;
    expect(result.message).toContain('videos (count 1, 0 found)');
    expect(result.report.captures[0]).toMatchObject({ name: 'videos', status: 'missing' });
  });

  it('warns for an optional capture that never matches and still succeeds', async () => {
    const browser = browserWith([{ url: PLAYLIST }]);
    const result = await runRecipe({
      recipe: loadRecipe(JSON.stringify(recipe([{ name: 'videos', match: 'playlist' }, { name: 'subtitles', match: '\\.vtt', optional: true }]))),
      browser,
      profileDir: '/p',
      timeoutMs: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.report.warnings.join('\n')).toContain('subtitles');
  });

  it('completes a row whose response never came before the session closes', async () => {
    const browser = browserWith([{ url: PLAYLIST, respondMs: 60_000 }]);
    const emitter = new RunEmitter();
    const log = recordEvents(emitter);
    const result = await runRecipe({ recipe: loadRecipe(JSON.stringify(recipe([{ name: 'videos', match: 'playlist' }]))), browser, profileDir: '/p', emitter });
    expect(result.ok).toBe(true);
    expect(log.of('capture.matched')[0]!.row).toMatchObject({ status: null, mime: null });
  });

  it('counts requests from popups', async () => {
    const browser = browserWith([]);
    const popupPage = 'https://learn.test/popup';
    browser.setPage(popupPage, { dom: h('html', {}), requests: [{ url: PLAYLIST }] });
    const page = browser.pages.get(PAGE)!;
    page.requests = [];
    page.dom = h('html', {}, h('body', {}, h('button', { id: 'open' }, 'open')));
    page.on = { click: () => ({ popup: popupPage }) };
    const input = {
      ...recipe([{ name: 'videos', match: 'playlist' }]),
      flows: [{ name: 'open', steps: [{ kind: 'click', target: { selectors: [{ strategy: 'id', value: 'open', stability: 'stable' }] } }] }],
      sequence: [{ flow: 'open' }],
    } as RecipeInput;
    const emitter = new RunEmitter();
    const log = recordEvents(emitter);
    const result = await runRecipe({ recipe: loadRecipe(JSON.stringify(input)), browser, profileDir: '/p', emitter, timeoutMs: 1_000 });
    expect(result.ok).toBe(true);
    expect(log.of('capture.matched')[0]!.row).toMatchObject({ url: PLAYLIST, frame: popupPage });
  });
});
