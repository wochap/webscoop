// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateDraft } from '@webscoop/core';
import { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';
import { Store } from '../src/store';
import { baseState, newDraft, renderPanel } from './panel';

afterEach(cleanup);

const startDownload = { name: 'deck.pdf', file: '/home/u/Downloads/webscoop/deck.pdf' };

describe('download notices', () => {
  it('shows a saved download as a notice for 4 seconds', () => {
    vi.useFakeTimers();
    const overlay = new Overlay(document.createElement('div'));
    const runtime = new Runtime({ win: window, store: new Store(), overlay });
    try {
      runtime.dispatch({ kind: 'download.saved', name: 'report.csv', file: '/dl/report.csv' });
      expect(runtime.store.get().ui.toasts.map((t) => t.text)).toEqual(['Saved report.csv']);
      vi.advanceTimersByTime(3999);
      expect(runtime.store.get().ui.toasts).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(runtime.store.get().ui.toasts).toEqual([]);
    } finally {
      runtime.dispose();
      overlay.dispose();
      vi.useRealTimers();
    }
  });

  it('says the start URL downloaded a file and offers a download step while the draft has no steps', () => {
    const p = renderPanel({ ...baseState(), startDownload });
    expect(p.q('flows-start-download')!.textContent).toContain('The URL downloaded deck.pdf');
    fireEvent.click(p.q('flows-start-download-add')!);
    expect(p.sent).toEqual([{ kind: 'draft.addDownloadStep' }]);
  });

  it('keeps the message but drops the action once the draft has a step, and shows nothing without a download', () => {
    const draft = validateDraft({ ...newDraft(), flows: [{ name: 'fetch', steps: [{ kind: 'download', window: 'same', optional: false, count: null }] }], activeFlow: 0 });
    const p = renderPanel({ ...baseState(draft), startDownload });
    expect(p.q('flows-start-download')).not.toBeNull();
    expect(p.q('flows-start-download-add')).toBeNull();
    cleanup();
    expect(renderPanel(baseState()).q('flows-start-download')).toBeNull();
  });
});
