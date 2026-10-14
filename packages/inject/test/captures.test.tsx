// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { reduceDraft, type Draft, type NetworkEntry } from '@webscoop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { baseState, newDraft, renderPanel } from './panel';

afterEach(cleanup);

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
  mime: url.includes('.m3u8') ? 'application/vnd.apple.mpegurl' : url.endsWith('.ts') ? 'video/mp2t' : 'application/json',
  frame: PLAYER,
  window: 'main',
  resourceType: 'xhr',
  at: Date.now(),
  failed: false,
  ...extra,
});

function withCaptures(captures: { name: string; match: string; optional?: boolean }[], draft: Draft = newDraft()): Draft {
  return captures.reduce((d, capture) => reduceDraft(d, { type: 'addCapture', capture }), draft);
}

/** A draft with no tables and no flows: only captures. */
function capturesOnly(): Draft {
  return withCaptures([{ name: 'videos', match: '/playlist\\.m3u8(\\?|$)' }]);
}

const open = (draft: Draft) => ({ ...baseState(draft), panel: { collapsed: { recipe: false, flows: false, sequence: false, captures: false } } });

describe('Captures section', () => {
  it('starts collapsed with its hint and Pick from network when empty', () => {
    const p = renderPanel(baseState());
    expect(p.q('section-captures')!.dataset.collapsed).toBe('true');
    expect(p.q('captures-summary')!.textContent).toBe('URLs from network requests');
    fireEvent.click(p.q('captures-pick')!);
    expect(p.sent).toEqual([{ kind: 'panel.setCollapsed', section: 'captures', collapsed: false }]);
    expect(p.store.get().ui.picker).toBe(true);
  });

  it('comes after the table content', () => {
    const p = renderPanel(open(withCaptures([{ name: 'videos', match: 'm3u8' }])), { showTables: true });
    const order = ['section-recipe', 'section-sequence', 'table-content', 'section-captures'].map((ws) => p.q(ws)!);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('updates the live badge as requests arrive, and shows the amber notice while a required capture has none', () => {
    const p = renderPanel(open(capturesOnly()));
    expect(p.q('capture-badge')!.textContent).toBe('0 matches');
    expect(p.q('capture-notice')).not.toBeNull();
    expect(p.q('footer-unmatched')!.textContent).toContain('1 unmatched');
    expect((p.q('footer-save') as HTMLButtonElement).disabled).toBe(false);
    act(() => p.store.setNetwork([entry(PLAYLIST)], false));
    expect(p.q('capture-badge')!.textContent).toBe('1 match');
    expect(p.q('capture-notice')).toBeNull();
    expect(p.q('footer-unmatched')).toBeNull();
  });

  it('makes a capture optional from the notice, and an optional one stays neutral', () => {
    const p = renderPanel(open(capturesOnly()));
    fireEvent.click(p.q('capture-make-optional')!);
    expect(p.sent).toEqual([{ kind: 'capture.update', index: 0, patch: { optional: true } }]);
    cleanup();
    const optional = renderPanel(open(withCaptures([{ name: 'subs', match: '\\.vtt', optional: true }])));
    expect(optional.q('capture-notice')).toBeNull();
    expect(optional.q('capture-badge')!.textContent).toBe('0 matches yet');
    expect(optional.q('capture-meta')!.textContent).toBe('waits for 1 · optional');
  });

  it('offers Edit, Show in picker, and Delete in its menu', () => {
    const p = renderPanel(open(capturesOnly()));
    fireEvent.click(p.q('capture-menu')!);
    fireEvent.click(p.q('capture-delete')!);
    expect(p.sent).toEqual([{ kind: 'capture.remove', index: 0 }]);
    fireEvent.click(p.q('capture-menu')!);
    fireEvent.click(p.q('capture-edit')!);
    expect(p.q('capture-editor')!.dataset.mode).toBe('edit');
  });
});

describe('Captures only', () => {
  it('shows the Recipe, Sequence, and Captures sections, the empty state naming the capture, and the footer counts', () => {
    const p = renderPanel(open(capturesOnly()));
    expect(p.q('section-flows')).toBeNull();
    expect(p.q('section-sequence')).not.toBeNull();
    expect(p.q('captures-only-text')!.textContent).toContain('videos');
    expect(p.q('flows-only')!.textContent).toContain('Captures only');
    expect(p.q('footer-count')!.textContent).toBe('0 tables · 1 capture');
    expect(p.q('sequence-open-url')).not.toBeNull();
    expect(p.q('sequence-capture-wait')!.textContent).toBe('wait for captures');
  });

  it('ends the collapsed sequence summary with the wait', () => {
    const p = renderPanel({ ...baseState(capturesOnly()) });
    expect(p.q('sequence-summary')!.textContent).toContain('open URL · wait for captures');
  });
});

describe('Network picker', () => {
  const picker = (log: NetworkEntry[], draft: Draft = newDraft()) => {
    const p = renderPanel(open(draft), { picker: true });
    act(() => p.store.setNetwork(log, true));
    return p;
  };

  it('lists the playlist first with a stream badge and the iframe host, newest first', () => {
    const p = picker([entry('https://api.test/me', { frame: 'http://127.0.0.1:4777/catalog?tier=0' }), entry(PLAYLIST), ...Array.from({ length: 3 }, (_, i) => entry(`${CDN}/1080p/video${i}.ts`))]);
    const first = p.qa('network-row')[0]!;
    expect(first.dataset.url).toBe(PLAYLIST);
    expect(first.querySelector('[data-ws="network-stream"]')).not.toBeNull();
    expect(first.querySelector('[data-ws="network-frame"]')!.textContent).toBe('iframe.mediadelivery.net');
    expect(p.q('network-group-label')!.textContent).toBe('/video0.ts … video2.ts');
    expect(p.q('network-counter')!.textContent).toBe('5 requests · 2 shown');
    fireEvent.click(p.qa('network-chip').find((c) => c.dataset.filter === 'all')!);
    expect(p.qa('network-row').map((r) => r.dataset.url)).toEqual([PLAYLIST, 'https://api.test/me']);
  });

  it('says when a filter shows nothing and offers to show all', () => {
    const p = picker([entry('https://api.test/me')]);
    expect(p.q('network-empty')!.textContent).toContain('No media requests yet');
    fireEvent.click(p.q('network-show-all')!);
    expect(p.qa('network-row')).toHaveLength(1);
  });

  it('moves with the arrows, picks with Enter into the editor, and closes with Esc', () => {
    const p = picker([entry(VARIANT), entry(PLAYLIST)]);
    fireEvent.keyDown(p.q('network-list')!, { key: 'ArrowDown' });
    fireEvent.keyDown(p.q('network-list')!, { key: 'Enter' });
    expect(p.store.get().ui.captureEditor).toMatchObject({ mode: 'new', url: VARIANT, stream: true });
    cleanup();
    const q = picker([entry(PLAYLIST)]);
    fireEvent.keyDown(q.q('network-list')!, { key: 'Escape' });
    expect(q.store.get().ui.picker).toBe(false);
  });
});

describe('Capture editor', () => {
  const editor = (url = PLAYLIST, draft: Draft = newDraft()) => {
    const p = renderPanel(open(draft), { picker: true, captureEditor: { mode: 'new', url, frame: PLAYER, stream: true } });
    act(() => p.store.setNetwork([entry(PLAYLIST), entry(VARIANT)], true));
    return p;
  };

  it('selects the filename chip by default with live counts per chip', () => {
    const p = editor();
    const chips = p.qa('capture-chip');
    expect(chips.map((c) => [c.dataset.kind, c.getAttribute('aria-pressed'), c.querySelector('.ws-count')!.textContent])).toEqual([
      ['filename', 'true', '1'],
      ['extension', 'false', '2'],
      ['hostExt', 'false', '2'],
      ['exact', 'false', '1'],
    ]);
    expect((p.q('capture-pattern') as HTMLInputElement).value).toBe('/playlist\\.m3u8(\\?|$)');
    expect((p.q('capture-name') as HTMLInputElement).value).toBe('videos');
    expect(p.q('capture-match-count')!.textContent).toBe('1 match');
    expect(p.q('capture-output')!.textContent).toBe('table videos · url, method, status, mime, frame');
  });

  it('says the exact URL matches only this URL', () => {
    const p = editor();
    fireEvent.click(p.qa('capture-chip').find((c) => c.dataset.kind === 'exact')!);
    expect(p.q('capture-helper')!.textContent).toBe('Matches only this URL. Other pages or videos won’t match.');
  });

  it('shows the regex error, deselects the chips, and disables Add', () => {
    const p = editor();
    fireEvent.change(p.q('capture-pattern')!, { target: { value: '\\.m3u8(\\?|$' } });
    expect(p.q('capture-helper')!.dataset.error).toBe('true');
    expect(p.qa('capture-chip').every((c) => c.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(p.q('capture-matches')!.textContent).toContain('fix the pattern');
    expect((p.q('capture-add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds the capture with its count and optional flag, and cancels with Esc', () => {
    const p = editor();
    fireEvent.click(p.q('capture-count-plus')!);
    fireEvent.click(p.q('capture-optional')!);
    fireEvent.click(p.q('capture-add')!);
    expect(p.sent).toEqual([{ kind: 'capture.add', capture: { name: 'videos', match: '/playlist\\.m3u8(\\?|$)', count: 2, optional: true } }]);
    expect(p.store.get().ui.captureEditor).toBeNull();
    cleanup();
    const q = editor();
    fireEvent.keyDown(q.q('capture-name')!, { key: 'Escape' });
    expect(q.store.get().ui.captureEditor).toBeNull();
  });

  it('makes the name unique against tables and captures', () => {
    const p = editor(PLAYLIST, withCaptures([{ name: 'videos', match: 'x' }]));
    expect((p.q('capture-name') as HTMLInputElement).value).toBe('videos-2');
  });
});

describe('compact network sheet', () => {
  it('sends capture.pick from a popup sheet', () => {
    const p = renderPanel(baseState(), { narrow: true, sheet: 'network' });
    act(() => p.store.setNetwork([entry(PLAYLIST, { id: 'p1', window: 'popup' })], true));
    expect(p.q('network-popup')!.textContent).toBe('popup');
    fireEvent.click(p.q('network-row')!);
    expect(p.sent).toEqual([{ kind: 'capture.pick', id: 'p1' }]);
  });
});

describe('picker in a popup that owns the panel', () => {
  it('hands the pick to the main window', () => {
    const p = renderPanel({ ...open(newDraft()), popup: true }, { picker: true });
    act(() => p.store.setNetwork([entry(PLAYLIST, { id: 'p2', window: 'popup' })], true));
    fireEvent.click(p.q('network-row')!);
    expect(p.sent).toEqual([{ kind: 'capture.pick', id: 'p2' }]);
    expect(p.store.get().ui.captureEditor).toBeNull();
  });
});

describe('test run drawer', () => {
  it('shows one tab per capture after the table tabs', () => {
    const state = {
      ...open(withCaptures([{ name: 'videos', match: 'm3u8' }])),
      test: {
        tables: [{ name: 'items', rows: [{ _page: 1, _index: 0, title: 'x' }], rowCount: 1, dropped: { count: 0, fields: [] }, fields: [{ name: 'title', status: 'ok' as const }] }],
        captures: [{ name: 'videos', rows: [{ url: PLAYLIST, _page: 1, _index: 0 }], rowCount: 1, status: 'ok' as const, count: 1, optional: false }],
        durationMs: 3,
        warnings: [],
      },
    };
    const p = renderPanel(state, { drawerOpen: true });
    expect(p.qa('results-tab').map((t) => t.dataset.table)).toEqual(['items', 'videos']);
    fireEvent.click(p.qa('results-tab')[1]!);
    expect(p.q('results-capture-status')!.textContent).toBe('ok');
    expect(p.q('results-table')!.textContent).toContain(PLAYLIST);
  });
});

describe('full URL', () => {
  it('shows on hover and on the right arrow, with a copy action', () => {
    const p = renderPanel(open(newDraft()), { picker: true });
    act(() => p.store.setNetwork([entry(PLAYLIST)], true));
    fireEvent.mouseEnter(p.q('network-row')!);
    expect(p.q('network-full-url')!.textContent).toContain(PLAYLIST);
    expect(p.q('network-copy')).not.toBeNull();
    fireEvent.mouseLeave(p.q('network-row')!);
    expect(p.q('network-full-url')).toBeNull();
    fireEvent.keyDown(p.q('network-list')!, { key: 'ArrowRight' });
    expect(p.q('network-full-url')).not.toBeNull();
  });
});
