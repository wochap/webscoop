// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { validateDraft, type Crumb, type DraftField, type ProtocolCandidate } from '@webscoop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, type Actions } from '../src/store';
import { RecorderProvider } from '../src/ui/context';
import { Icon, ICON_NAMES } from '../src/ui/icons';
import { AncestorBreadcrumb, shownCrumbs } from '../src/ui/picking';
import { Section } from '../src/ui/section';
import { SelectorChip, selectorDisplay, STRATEGIES } from '../src/ui/selector-chip';
import { applyTyping, SelectorInput, splitSelector } from '../src/ui/selector-input';
import { baseState, newDraft, renderPanel } from './panel';

afterEach(cleanup);

const cand = (strategy: ProtocolCandidate['strategy'], value: string, stability: ProtocolCandidate['stability'] = 'stable'): ProtocolCandidate => ({ strategy, value, stability });

/** Render inside a provider whose actions record what is sent. */
function withActions(node: React.ReactNode, extra: Partial<Actions> = {}) {
  const store = new Store();
  const sent: unknown[] = [];
  const actions: Actions = {
    send: async (msg) => void sent.push(msg),
    startPicking: () => {},
    cancelPicking: () => {},
    startBrowsing: () => {},
    stopBrowsing: () => {},
    selectPath: () => {},
    setUi: (patch) => store.setUi(patch),
    toast: () => {},
    dismissToast: () => {},
    ...extra,
  };
  const view = render(
    <RecorderProvider store={store} actions={actions} drawerHost={null}>
      {node}
    </RecorderProvider>,
  );
  return { ...view, sent };
}

describe('icons', () => {
  it('renders every glyph as inline SVG in currentColor', () => {
    expect(ICON_NAMES).toHaveLength(27);
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('fill'), name).toBe('currentColor');
      expect(svg.getAttribute('viewBox')).toBe('0 0 256 256');
      expect(svg.querySelector('path')!.getAttribute('d')!.length, name).toBeGreaterThan(10);
      unmount();
    }
    const bold = render(<Icon name="flask" weight="bold" />).container.querySelector('path')!.getAttribute('d');
    const regular = render(<Icon name="flask" />).container.querySelector('path')!.getAttribute('d');
    expect(bold).not.toBe(regular);
  });
});

describe('selector chip', () => {
  it('prettifies every strategy', () => {
    const shown = (c: ProtocolCandidate) => {
      const d = selectorDisplay(c);
      return [d.main, d.quoted, d.direct];
    };
    expect(STRATEGIES).toEqual(['role', 'testid', 'id', 'class', 'text', 'css', 'xpath']);
    expect(shown(cand('role', 'heading|LLM Leaderboard 2026'))).toEqual(['heading', ' "LLM Leaderboard 2026"', false]);
    expect(shown(cand('role', 'listitem'))).toEqual(['listitem', '', false]);
    expect(shown(cand('testid', 'price'))).toEqual(['price', '', false]);
    expect(shown(cand('id', '#rso'))).toEqual(['rso', '', false]);
    expect(shown(cand('id', 'rso'))).toEqual(['rso', '', false]);
    expect(shown(cand('class', '.product-title'))).toEqual(['product-title', '', false]);
    expect(shown(cand('text', 'Add to cart'))).toEqual(['', '"Add to cart"', false]);
    expect(shown(cand('css', ':scope > div > div > div', 'medium'))).toEqual(['div > div > div', '', true]);
    expect(shown(cand('css', ':scope>h3', 'medium'))).toEqual(['h3', '', true]);
    expect(shown(cand('xpath', '//ol/li', 'fragile'))).toEqual(['ol/li', '', false]);
    expect(selectorDisplay(cand('css', ':scope > a', 'fragile')).full).toBe('css=:scope > a · fragile');
  });

  it('shows the tag, value, stability dot, level stripe, and the full value on hover', () => {
    const tags = STRATEGIES.map((s) => {
      const { container, unmount } = render(<SelectorChip candidate={cand(s, 'x')} />);
      const tag = container.querySelector('.ws-sel-tag')!;
      const out = tag.querySelector('svg')?.dataset.icon ?? tag.textContent;
      unmount();
      return out;
    });
    expect(tags).toEqual(['person-simple', 'flask', '#', '.', 'text-t', '{}', '//']);

    const role = render(<SelectorChip candidate={cand('role', 'heading|LLM Leaderboard 2026')} />).container.querySelector('[data-ws="selector-chip"]') as HTMLElement;
    expect(role.querySelector('[data-ws="selector-value"]')!.textContent).toBe('heading "LLM Leaderboard 2026"');
    expect(role.querySelector('.ws-sel-dot')!.getAttribute('data-stability')).toBe('stable');
    cleanup();

    const item = render(<SelectorChip candidate={cand('css', ':scope > div > div > div', 'medium')} level="item" />).container.querySelector('[data-ws="selector-chip"]') as HTMLElement;
    expect(item.dataset.level).toBe('item');
    expect(item.querySelector('.ws-sel-tag')!.textContent).toBe('{}');
    expect(item.querySelector('[data-ws="selector-direct"]')).not.toBeNull();
    expect(item.querySelector('[data-ws="selector-value"]')!.textContent).toBe('div > div > div');
    cleanup();

    const long = 'div.VwiC3b.yXK7lf.p4wth.r025kc.hJNv6b.Hdw6tb.very-long-class-name-that-overflows';
    const field = render(<SelectorChip candidate={cand('class', long, 'fragile')} />).container.querySelector('[data-ws="selector-chip"]') as HTMLElement;
    // Cut with an ellipsis by CSS; the whole selector and its stability on hover.
    expect(field.querySelector('[data-ws="selector-value"]')!.className).toBe('ws-sel-value');
    expect(field.title).toBe(`class=${long} · fragile`);
  });
});

describe('selector input', () => {
  it('splits and switches strategy the way the host parses', () => {
    expect(splitSelector('xpath=//ol/li')).toEqual({ strategy: 'xpath', value: '//ol/li' });
    expect(splitSelector('//ol/li')).toEqual({ strategy: 'xpath', value: '//ol/li' });
    expect(splitSelector('h3')).toEqual({ strategy: 'css', value: 'h3' });
    expect(applyTyping('css', 'xpath=//ol/li')).toEqual({ strategy: 'xpath', value: '//ol/li' });
    expect(applyTyping('css', './li')).toEqual({ strategy: 'xpath', value: './li' });
    expect(applyTyping('css', '/html')).toEqual({ strategy: 'xpath', value: '/html' });
    expect(applyTyping('role', '/html')).toEqual({ strategy: 'role', value: '/html' });
    expect(applyTyping('id', 'nope=1')).toEqual({ strategy: 'id', value: 'nope=1' });
  });

  it('switches the dropdown on paste and submits strategy=value', () => {
    const submitted: string[] = [];
    const p = withActions(<SelectorInput label="Item selector" testId="sel" onSubmit={(t) => submitted.push(t)} />);
    const box = p.container.querySelector('[data-ws="sel"]') as HTMLInputElement;
    const strategy = p.container.querySelector('[data-ws="sel-strategy"]') as HTMLSelectElement;
    expect(strategy.value).toBe('css');
    expect(Array.from(strategy.options).map((o) => o.value)).toEqual(['role', 'testid', 'id', 'class', 'text', 'css', 'xpath']);
    fireEvent.change(box, { target: { value: 'xpath=//ol/li' } });
    expect(strategy.value).toBe('xpath');
    expect(box.value).toBe('//ol/li');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(submitted).toEqual(['xpath=//ol/li']);

    // Typed role selector: choose role, type the value, submit.
    fireEvent.change(strategy, { target: { value: 'role' } });
    fireEvent.change(box, { target: { value: 'listitem' } });
    fireEvent.submit(box.closest('form')!);
    expect(submitted.at(-1)).toBe('role=listitem');
  });

  it('shows the count, the pick and candidates controls, and the invalid state', async () => {
    const counted: [string, string][] = [];
    let picked = 0;
    const p = withActions(
      <SelectorInput label="Item selector" testId="sel" value="css=h3" count={24} scope="item" onSubmit={() => {}} onPick={() => picked++} candidates={6} onCandidates={() => {}} error="matches nothing" />,
      {
        countSelector: async (text, scope) => {
          counted.push([text, scope]);
          return 7;
        },
      },
    );
    const count = p.container.querySelector('[data-ws="sel-count"]') as HTMLElement;
    expect(count.textContent).toBe('24');
    expect(p.container.querySelector('[data-ws="selector-input"]')!.hasAttribute('data-invalid')).toBe(true);
    expect(p.container.querySelector('[data-ws="sel-error"]')!.textContent).toBe('matches nothing');
    fireEvent.click(p.container.querySelector('[data-ws="sel-pick"]')!);
    expect(picked).toBe(1);
    expect(p.container.querySelector('[data-ws="sel-candidates"]')!.textContent).toBe('6');
    // A typed value is counted live, after a pause.
    fireEvent.change(p.container.querySelector('[data-ws="sel"]')!, { target: { value: 'h2' } });
    expect(count.textContent).toBe('—');
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(counted).toEqual([['css=h2', 'item']]);
    expect(count.textContent).toBe('7');
  });
});

describe('sections', () => {
  it('collapses to the summary and expands to the content', () => {
    const changes: boolean[] = [];
    const view = (collapsed: boolean) => (
      <Section id="recipe" title="Recipe" count={2} collapsible collapsed={collapsed} onCollapse={(c) => changes.push(c)} summary="one line" actions={<button type="button">act</button>}>
        <p data-ws="content">content</p>
      </Section>
    );
    const r = render(view(false));
    const q = (ws: string) => r.container.querySelector(`[data-ws="${ws}"]`);
    expect(q('content')).not.toBeNull();
    expect(q('section-summary')).toBeNull();
    expect(q('section-count')!.textContent).toBe('2');
    fireEvent.click(q('section-toggle')!);
    expect(changes).toEqual([true]);
    r.rerender(view(true));
    expect(q('content')).toBeNull();
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
    const order = ['mode', 'section-recipe', 'section-steps', 'section-pagination', 'tables', 'table-header', 'section-rows', 'section-pick', 'section-fields', 'save'];
    const nodes = order.map((ws) => p.q(ws)!);
    for (const [i, node] of nodes.entries()) expect(node, order[i]).not.toBeNull();
    for (let i = 1; i < nodes.length; i++) expect(nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${order[i - 1]} before ${order[i]}`).toBeTruthy();
    expect(p.qa('table-tab').map((t) => t.dataset.table)).toEqual(['results', 'page']);
    // Header and footer sit outside the scrolling body.
    expect(p.q('body')!.contains(p.q('mode'))).toBe(false);
    expect(p.q('body')!.contains(p.q('save'))).toBe(false);
    expect(p.q('section-pagination')!.dataset.collapsed).toBe('true');
    expect(p.q('section-recipe')!.dataset.collapsed).toBeUndefined();
    expect(p.q('section-steps')!.dataset.collapsed).toBeUndefined();
  });

  it('shows the collapsed recipe as one line with the name and the URL with its variable values', () => {
    const draft = { ...newDraft(), name: 'google-com-search', url: 'https://www.google.com/search?q={query}', vars: [{ name: 'query', value: 'top llms' }] };
    const p = renderPanel({ ...baseState(draft), panel: { collapsed: { recipe: true, steps: false, pagination: true } } });
    const summary = p.q('section-recipe')!.querySelector('[data-ws="section-summary"]')!;
    expect(p.q('recipe-bar')).toBeNull();
    expect(summary.querySelector('[data-ws="recipe-summary-name"]')!.textContent).toBe('google-com-search');
    expect(summary.querySelector('[data-ws="recipe-summary-url"]')!.textContent).toBe('https://www.google.com/search?q=querytop llms');
    expect(summary.querySelector('[data-ws="summary-var-query"] .ws-chip-value')!.textContent).toBe('top llms');
    fireEvent.click(p.q('section-recipe')!.querySelector('[data-ws="section-toggle"]')!);
    expect(p.sent).toEqual([{ kind: 'panel.setCollapsed', section: 'recipe', collapsed: false }]);
  });

  it('reflects an edited template in the collapsed recipe and leaves unused variables out', () => {
    const draft = {
      ...newDraft(),
      name: 'google-com-search',
      url: 'https://www.google.com/search?q={query}&hl={lang}',
      vars: [
        { name: 'query', value: 'top llms' },
        { name: 'lang', value: 'en' },
        { name: 'email', value: 'me@acme.dev', added: true as const },
      ],
    };
    const p = renderPanel({ ...baseState(draft), panel: { collapsed: { recipe: true, steps: false, pagination: true } } });
    const summary = p.q('section-recipe')!.querySelector('[data-ws="section-summary"]')!;
    expect(summary.querySelector('[data-ws="recipe-summary-url"]')!.textContent).toBe('https://www.google.com/search?q=querytop llms&hl=langen');
    expect(summary.querySelector('[data-ws="summary-var-lang"] .ws-chip-value')!.textContent).toBe('en');
    expect(summary.querySelector('[data-ws="summary-var-email"]')).toBeNull();
  });
});

describe('ancestor breadcrumb', () => {
  const trail: Crumb[] = Array.from({ length: 23 }, (_, i) => ({ label: i === 22 ? 'h3' : `div${i}`, path: Array.from({ length: i + 1 }, () => 0) }));

  it('shows the last three crumbs ending in the selection, and every crumb after the expander', () => {
    const selected: number[][] = [];
    const r = render(<AncestorBreadcrumb trail={trail} current={trail[22]!.path} onSelect={(p) => selected.push(p)} />);
    const labels = () => Array.from(r.container.querySelectorAll('[data-ws="crumb"]')).map((c) => c.textContent);
    expect(labels()).toEqual(['div20', 'div21', 'h3']);
    expect(r.container.querySelector('[data-ws="crumb-expand"]')).not.toBeNull();
    fireEvent.click(r.container.querySelector('[data-ws="crumb-expand"]')!);
    expect(labels()).toHaveLength(23);
    expect(r.container.querySelector('[data-ws="crumb-expand"]')).toBeNull();
  });

  it('follows the selection as it walks up', () => {
    expect(shownCrumbs(trail, trail[20]!.path, false).crumbs.map((c) => c.label)).toEqual(['div18', 'div19', 'div20']);
    expect(shownCrumbs(trail.slice(0, 2), trail[1]!.path, false)).toEqual({ crumbs: trail.slice(0, 2), hidden: 0 });
  });
});
