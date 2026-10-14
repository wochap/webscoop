import { describe, expect, it } from 'vitest';
import { draftFromRecipe, draftToRecipe, emptyDraft, flowsOnly, loadRecipe, NETWORK_LOG_MAX, reduceDraft, validateRecipe, type HostMessage, type RecipeInput } from '../src';
import { h } from '../src/testing';
import { harness } from './recorder-helpers';

const VIDEO = 'http://127.0.0.1:4777/video?id=42';
const PLAYLIST = 'http://localhost:4777/stream/42/playlist.m3u8';
const PLAYER = 'http://localhost:4777/video/player?id=42';

const lesson: RecipeInput = {
  schemaVersion: 2,
  name: 'lesson-video',
  url: 'http://127.0.0.1:4777/video?id={id}',
  vars: [{ name: 'id', type: 'string', default: '42' }],
  captures: [
    { name: 'videos', match: '/playlist\\.m3u8(\\?|$)', description: 'HLS playlist URL' },
    { name: 'subs', match: '\\.vtt', count: 2, optional: true },
  ],
};

describe('draft captures', () => {
  it('round-trips a captures-only recipe through the draft', () => {
    const draft = draftFromRecipe(loadRecipe(JSON.stringify(lesson)));
    expect(draft.captures).toEqual([
      { name: 'videos', match: '/playlist\\.m3u8(\\?|$)', count: 1, optional: false, description: 'HLS playlist URL' },
      { name: 'subs', match: '\\.vtt', count: 2, optional: true },
    ]);
    expect(flowsOnly(draft)).toBe(true);
    expect(draft.sequence.custom).toBe(false);
    const back = draftToRecipe(draft);
    expect(back).toMatchObject({ captures: lesson.captures, sequence: [] });
    expect(back.tables).toBeUndefined();
    expect(back.fields).toBeUndefined();
    expect(validateRecipe(back).ok).toBe(true);
  });

  it('adds, updates, and removes captures, keeping names unique against tables and downloads', () => {
    let draft = emptyDraft({ name: 'lesson-video', url: VIDEO, vars: [] });
    draft = reduceDraft(draft, { type: 'addCapture', capture: { name: 'videos', match: 'm3u8' } });
    draft = reduceDraft(draft, { type: 'addCapture', capture: { name: 'videos', match: 'mpd' } });
    draft = reduceDraft(draft, { type: 'addCapture', capture: { name: 'downloads', match: 'x' } });
    expect(draft.captures.map((c) => c.name)).toEqual(['videos', 'videos-2', 'downloads-2']);
    expect(draft.dirty).toBe(true);
    draft = reduceDraft(draft, { type: 'updateCapture', index: 1, patch: { optional: true, count: 3, description: ' manifests ' } });
    expect(draft.captures[1]).toEqual({ name: 'videos-2', match: 'mpd', count: 3, optional: true, description: 'manifests' });
    draft = reduceDraft(draft, { type: 'removeCapture', index: 2 });
    expect(draft.captures).toHaveLength(2);
    expect(draftToRecipe(draft).captures).toEqual([{ name: 'videos', match: 'm3u8' }, { name: 'videos-2', match: 'mpd', count: 3, optional: true, description: 'manifests' }]);
  });

  it('marks a capture whose regex does not compile, and one clashing with a table', () => {
    let draft = emptyDraft({ name: 'lesson-video', url: VIDEO, vars: [] });
    draft = reduceDraft(draft, { type: 'addCapture', capture: { name: 'videos', match: '\\.m3u8(\\?|$' } });
    expect(draft.captures[0]!.error).toContain('not a valid regex');
    draft = reduceDraft(draft, { type: 'updateCapture', index: 0, patch: { match: 'm3u8', name: 'items' } });
    expect(draft.captures[0]!.error).toBeUndefined();
  });
});

describe('RecorderController network log', () => {
  const page = h('html', {}, h('body', {}, h('h1', {}, 'Lesson 42')));
  const draft = () => emptyDraft({ name: 'lesson-video', url: VIDEO, vars: [] });
  const networkMessages = (dispatched: unknown[]) => dispatched.filter((m): m is HostMessage & { kind: 'network.requests' } => (m as HostMessage).kind === 'network.requests');

  it('keeps every request across navigations and sends batches at most every 250 ms', async () => {
    const t = await harness(page, draft(), VIDEO, { requests: [{ url: PLAYLIST, frameUrl: PLAYER, mime: 'application/vnd.apple.mpegurl' }] });
    expect(t.controller.requests).toEqual([expect.objectContaining({ url: PLAYLIST, frame: PLAYER, status: 200, mime: 'application/vnd.apple.mpegurl', window: 'main' })]);
    for (let i = 0; i < 5; i++) t.session.emitRequest({ url: `http://localhost:4777/stream/42/1080p/video${i}.ts`, mime: 'video/mp2t' });
    await new Promise((r) => setTimeout(r, 400));
    const batches = networkMessages(t.session.dispatched);
    expect(batches.length).toBeLessThanOrEqual(2);
    expect(batches.flatMap((b) => b.entries.map((e) => e.url))).toContain(PLAYLIST);
    // The page is injected again after a navigation and asks for the whole log.
    await t.send({ kind: 'session.ready', url: VIDEO });
    await t.controller.idle();
    const reset = networkMessages(t.session.dispatched).at(-1)!;
    expect(reset.reset).toBe(true);
    expect(reset.entries).toHaveLength(6);
    t.controller.dispose();
  });

  it('keeps only the newest entries', async () => {
    const t = await harness(page, draft(), VIDEO);
    for (let i = 0; i < NETWORK_LOG_MAX + 5; i++) t.session.emitRequest({ url: `http://cdn.test/s${i}.ts` });
    expect(t.controller.requests).toHaveLength(NETWORK_LOG_MAX);
    expect(t.controller.requests[0]!.url).toBe('http://cdn.test/s5.ts');
    t.controller.dispose();
  });

  it('applies captures in the panel test run, waiting for a late request', async () => {
    const t = await harness(page, draft(), VIDEO, { requests: [{ url: PLAYLIST, frameUrl: PLAYER, afterMs: 100 }] });
    await t.send({ kind: 'capture.add', capture: { name: 'videos', match: '/playlist\\.m3u8(\\?|$)' } });
    expect(t.controller.state.panel.collapsed.captures).toBe(false);
    const reply = (await t.send({ kind: 'test.run' })) as HostMessage & { kind: 'test.results' };
    expect(reply.results.captures).toEqual([
      { name: 'videos', rows: [{ url: PLAYLIST, method: 'GET', status: 200, mime: 'application/octet-stream', frame: PLAYER, _page: 1, _index: 0 }], rowCount: 1, status: 'ok', count: 1, optional: false },
    ]);
    t.controller.dispose();
  });
});
