import type { NetworkEntry } from '@webscoop/core';
import { describe, expect, it } from 'vitest';
import { escapeRegex, frameHost, inFilter, matchingUrls, mergeNetwork, NETWORK_LOG_MAX, patternChips, pickerRows, regexError, shortHost } from '../src/network';

const CDN = 'https://vz-aa93bf80-5cb.b-cdn.net/0999851b';
const PLAYLIST = `${CDN}/playlist.m3u8`;
const VARIANT = `${CDN}/1080p/video.m3u8`;
const PLAYER = 'https://iframe.mediadelivery.net/embed/1/0999851b';

let n = 0;
const entry = (url: string, extra: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: `r${++n}`,
  url,
  method: 'GET',
  status: 200,
  mime: url.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : url.endsWith('.ts') ? 'video/mp2t' : 'application/json',
  frame: PLAYER,
  window: 'main',
  resourceType: 'xhr',
  at: n,
  failed: false,
  ...extra,
});

describe('pattern chips', () => {
  it('defaults to the filename chip and counts each chip live', () => {
    const chips = patternChips(PLAYLIST);
    expect(chips.map((c) => [c.kind, c.pattern])).toEqual([
      ['filename', '/playlist\\.m3u8(\\?|$)'],
      ['extension', '\\.m3u8(\\?|$)'],
      ['hostExt', 'vz-aa93bf80-5cb\\.b-cdn\\.net/.*\\.m3u8(\\?|$)'],
      ['exact', escapeRegex(PLAYLIST)],
    ]);
    const log = [entry(PLAYLIST), entry(VARIANT), entry(PLAYLIST)];
    expect(chips.map((c) => matchingUrls(c.pattern, log).length)).toEqual([1, 2, 2, 1]);
  });

  it('drops the extension chips without an extension and names a trailing slash segment', () => {
    expect(patternChips('https://api.test/v1/videos/').map((c) => [c.kind, c.pattern])).toEqual([
      ['filename', '/videos/(\\?|$)'],
      ['exact', 'https://api\\.test/v1/videos/'],
    ]);
  });

  it('reports a pattern that does not compile', () => {
    expect(regexError('\\.m3u8(\\?|$')).toMatch(/Unterminated group/);
    expect(regexError('\\.m3u8')).toBeNull();
    expect(matchingUrls('(', [entry(PLAYLIST)])).toEqual([]);
  });
});

describe('picker rows', () => {
  it('folds segments that share a prefix into one group below the streams', () => {
    const log = [entry(PLAYLIST), ...Array.from({ length: 42 }, (_, i) => entry(`${CDN}/1080p/video${i}.ts`)), entry('https://api.test/me')];
    const rows = pickerRows(log.filter((e) => inFilter(e, 'media')));
    expect(rows.map((r) => r.kind)).toEqual(['request', 'segments']);
    const group = rows[1]!;
    expect(group.kind === 'segments' && [group.first, group.last, group.entries.length]).toEqual(['video0.ts', 'video41.ts', 42]);
    expect(pickerRows(log).map((r) => (r.kind === 'request' ? r.entry.url : 'group'))).toEqual([PLAYLIST, 'group', 'https://api.test/me']);
  });

  it('counts repeats of one URL, range requests without their query', () => {
    const rows = pickerRows([entry(PLAYLIST), entry(PLAYLIST), entry(PLAYLIST), entry(`${CDN}/teaser.mp4?r=1`, { status: 206 }), entry(`${CDN}/teaser.mp4?r=2`, { status: 206 })]);
    expect(rows.map((r) => r.kind === 'request' && [r.entry.url.split('/').pop(), r.repeats, r.stream])).toEqual([
      ['teaser.mp4?r=2', 2, true],
      ['playlist.m3u8', 3, true],
    ]);
  });

  it('classifies media, XHR, and all, and badges frames on another host', () => {
    const fetched = entry('https://api.test/me', { resourceType: 'fetch', frame: 'https://shop.test/' });
    expect(inFilter(fetched, 'media')).toBe(false);
    expect(inFilter(fetched, 'xhr')).toBe(true);
    expect(inFilter(entry(PLAYLIST), 'media')).toBe(true);
    expect(frameHost(entry(PLAYLIST), 'https://academy.test/lesson/4')).toBe('iframe.mediadelivery.net');
    expect(frameHost(fetched, 'https://shop.test/c')).toBeNull();
    expect(frameHost(entry(PLAYLIST, { window: 'popup' }), 'https://academy.test/')).toBeNull();
    expect(shortHost('vz-aa93bf80-5cb.b-cdn.net')).toBe('vz-aa93…b-cdn.net');
  });

  it('merges batches by id and keeps the newest entries', () => {
    const a = entry(PLAYLIST, { status: null });
    const merged = mergeNetwork([a], [{ ...a, status: 200 }, entry(VARIANT)], false);
    expect(merged.map((e) => [e.url, e.status])).toEqual([
      [PLAYLIST, 200],
      [VARIANT, 200],
    ]);
    expect(mergeNetwork(merged, [entry(VARIANT)], true)).toHaveLength(1);
    expect(mergeNetwork([], Array.from({ length: NETWORK_LOG_MAX + 3 }, (_, i) => entry(`https://x.test/${i}`)), false)).toHaveLength(NETWORK_LOG_MAX);
  });
});
