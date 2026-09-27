// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { validateDraft, type DraftField } from '@webscoop/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mode } from '../src/store';
import { Section } from '../src/ui/section';
import { baseState, newDraft, renderPanel } from './panel';
import { MODE_TONE, ModePill } from '../src/ui/shell';

afterEach(cleanup);

describe('sections', () => {
  it('collapses to the summary and expands to the content', () => {
    const changes: boolean[] = [];
    const view = (collapsed: boolean) => (
      <Section id="recipe" title="Recipe" count={2} collapsible collapsed={collapsed} onCollapse={(c) => changes.push(c)} summary="one line" actions={<button type="button">act</button>}>
        <p className="content">content</p>
      </Section>
    );
    const r = render(view(false));
    const q = (ws: string) => r.container.querySelector(`[data-ws="${ws}"]`);
    expect(r.container.querySelector('.content')).not.toBeNull();
    expect(q('section-summary')).toBeNull();
    expect(q('section-count')!.textContent).toBe('2');
    fireEvent.click(q('section-toggle')!);
    expect(changes).toEqual([true]);
    r.rerender(view(true));
    expect(r.container.querySelector('.content')).toBeNull();
    expect(q('section-summary')!.textContent).toBe('one line');
    expect(q('section-toggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(r.container.textContent).toContain('act');
    cleanup();
    const plain = render(<Section id="fields" title="Fields" />);
    expect(plain.container.querySelector('[data-ws="section-toggle"]')).toBeNull();
  });

  it('lays the panel out as header, Recipe, Steps, Pagination, tabs, table header, Rows, Pick, Fields, footer', () => {
    const css = (value: string) => ({ strategy: 'css' as const, value, stability: 'medium' as const });
    const field = (name: string, scope: DraftField['scope']): DraftField => ({ name, type: 'text', scope, selectors: [css(`.${name}`)], optional: false, key: false, count: 10, sample: name });
    const step = { kind: 'click' as const, target: { selectors: [css('button')] }, optional: false, when: 'first-page' as const, count: 1 };
    const draft = validateDraft({
      ...newDraft(),
      steps: [step, step],
      pagination: { kind: 'next', limit: 3, stopRules: [], delayMs: 0 },
      tables: [
        { name: 'results', item: { selectors: [css('.card')], exclude: [], count: 10, total: 10 }, fields: [field('title', 'item')] },
        { name: 'page', item: null, fields: [field('heading', 'page')] },
      ],
      activeTable: 0,
      form: 'tables',
    });
    const p = renderPanel(baseState(draft));
    const order = ['panel-mode', 'section-recipe', 'section-steps', 'section-pagination', 'tabs', 'table-header', 'section-rows', 'section-pick', 'section-fields', 'footer-save'];
    const nodes = order.map((ws) => p.q(ws)!);
    for (const [i, node] of nodes.entries()) expect(node, order[i]).not.toBeNull();
    for (let i = 1; i < nodes.length; i++) expect(nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${order[i - 1]} before ${order[i]}`).toBeTruthy();
    expect(p.qa('tab').map((t) => t.dataset.table)).toEqual(['results', 'page']);
    // Header and footer sit outside the scrolling body.
    expect(p.q('panel-body')!.contains(p.q('panel-mode'))).toBe(false);
    expect(p.q('panel-body')!.contains(p.q('footer-save'))).toBe(false);
    expect(p.q('section-pagination')!.dataset.collapsed).toBe('true');
    expect(p.q('section-recipe')!.dataset.collapsed).toBeUndefined();
    expect(p.q('section-steps')!.dataset.collapsed).toBeUndefined();
  });
});

describe('shell', () => {
  it('renders every mode pill tone', () => {
    const modes: Mode[] = ['idle', 'picking', 'selected', 'items', 'editing', 'test'];
    for (const mode of modes) {
      const { container, unmount } = render(<ModePill mode={mode} />);
      const pill = container.querySelector('[data-ws="panel-mode"]')!;
      expect(pill.className).toContain(`ws-tone-${MODE_TONE[mode]}`);
      expect(pill.getAttribute('data-mode')).toBe(mode);
      unmount();
    }
    expect(new Set(Object.values(MODE_TONE))).toEqual(new Set(['neutral', 'accent', 'ok', 'warn']));
  });

  it('shows the idle mode, the footer, and picking after p', () => {
    const p = renderPanel(baseState());
    expect(p.q('panel-mode')!.dataset.mode).toBe('idle');
    expect(p.q('footer-save')).not.toBeNull();
    fireEvent.keyDown(p.q('panel-body')!, { key: 'p' });
    expect(p.q('panel-mode')!.dataset.mode).toBe('picking');
    expect(p.q('pick-strip')!.dataset.picking).toBe('true');
  });

  it('ends the session from the header', () => {
    const p = renderPanel(baseState());
    fireEvent.click(p.q('panel-end')!);
    expect(p.sent).toEqual([{ kind: 'session.end' }]);
  });

  it('shows unsaved changes, then the saved name, in the footer', () => {
    const dirty = renderPanel(baseState({ ...newDraft(), dirty: true }));
    expect(dirty.q('footer-status')!.textContent).toBe('Unsaved changes');
    cleanup();
    const saved = renderPanel({ ...baseState(), saved: { name: 'shop-catalog', at: '2026-09-27T00:00:00Z' } });
    expect(saved.q('footer-status')!.textContent).toBe('Saved shop-catalog');
    cleanup();
    expect(renderPanel(baseState()).q('footer-status')!.textContent).toBe('');
  });
});
