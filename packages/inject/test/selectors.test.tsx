// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { type ProtocolCandidate, emptyDraft, pathOf } from '@webscoop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, type Actions } from '../src/store';
import { RecorderProvider } from '../src/ui/context';
import { Icon, ICON_NAMES } from '../src/ui/icons';
import { SelectorChip, selectorDisplay, STRATEGIES } from '../src/ui/selector-chip';
import { applyTyping, SelectorInput, splitSelector } from '../src/ui/selector-input';
import { chooseOption, renderPanel } from './panel';
import { acceptList, byClass, harness, openList, RESULTS } from '../../core/test/recorder-helpers';
import { resultsSnapshot } from '../../core/test/snapshot';
import { selectorChain } from '../src/chain';

afterEach(cleanup);

const cand = (strategy: ProtocolCandidate['strategy'], value: string, stability: ProtocolCandidate['stability'] = 'stable'): ProtocolCandidate => ({ strategy, value, stability });

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

const c = (strategy: 'id' | 'css' | 'class', value: string) => ({ strategy, value, stability: 'medium' as const });

const levels = (el: Element | null | undefined) =>
  Array.from(el?.querySelectorAll('[data-ws="stack-level"]') ?? []).map((row) => [
    (row as HTMLElement).dataset.level,
    (row.querySelector('[data-ws="chip"]') as HTMLElement).dataset.selector,
  ]);

describe('icons', () => {
  it('renders every glyph as inline SVG in currentColor', () => {
    expect(ICON_NAMES).toHaveLength(28);
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

    const role = render(<SelectorChip candidate={cand('role', 'heading|LLM Leaderboard 2026')} />).container.querySelector('[data-ws="chip"]') as HTMLElement;
    expect(role.querySelector('[data-ws="chip-value"]')!.textContent).toBe('heading "LLM Leaderboard 2026"');
    expect(role.querySelector('.ws-sel-dot')!.getAttribute('data-stability')).toBe('stable');
    cleanup();

    const item = render(<SelectorChip candidate={cand('css', ':scope > div > div > div', 'medium')} level="item" />).container.querySelector('[data-ws="chip"]') as HTMLElement;
    expect(item.dataset.level).toBe('item');
    expect(item.querySelector('.ws-sel-tag')!.textContent).toBe('{}');
    expect(item.querySelector('[data-ws="chip-direct"]')).not.toBeNull();
    expect(item.querySelector('[data-ws="chip-value"]')!.textContent).toBe('div > div > div');
    cleanup();

    const long = 'div.VwiC3b.yXK7lf.p4wth.r025kc.hJNv6b.Hdw6tb.very-long-class-name-that-overflows';
    const field = render(<SelectorChip candidate={cand('class', long, 'fragile')} />).container.querySelector('[data-ws="chip"]') as HTMLElement;
    // Cut with an ellipsis by CSS; the whole selector and its stability on hover.
    expect(field.querySelector('[data-ws="chip-value"]')!.className).toBe('ws-sel-value');
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
    const p = withActions(<SelectorInput label="Item selector" testId="pick-selector" onSubmit={(t) => submitted.push(t)} />);
    const box = p.container.querySelector('[data-ws="pick-selector"]') as HTMLInputElement;
    const strategy = p.container.querySelector('[data-ws="pick-selector-strategy"]') as HTMLButtonElement;
    expect(strategy.value).toBe('css');
    fireEvent.click(strategy);
    expect(Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.dataset.value)).toEqual(['role', 'testid', 'id', 'class', 'text', 'css', 'xpath']);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.change(box, { target: { value: 'xpath=//ol/li' } });
    expect(strategy.value).toBe('xpath');
    expect(box.value).toBe('//ol/li');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(submitted).toEqual(['xpath=//ol/li']);

    // Typed role selector: choose role, type the value, submit.
    chooseOption(strategy, 'role');
    fireEvent.change(box, { target: { value: 'listitem' } });
    fireEvent.submit(box.closest('form')!);
    expect(submitted.at(-1)).toBe('role=listitem');
  });

  it('shows the count, the pick and candidates controls, and the invalid state', async () => {
    const counted: [string, string][] = [];
    let picked = 0;
    const p = withActions(
      <SelectorInput label="Item selector" testId="pick-selector" value="css=h3" count={24} scope="item" onSubmit={() => {}} onPick={() => picked++} candidates={6} onCandidates={() => {}} error="matches nothing" />,
      {
        countSelector: async (text, scope) => {
          counted.push([text, scope]);
          return 7;
        },
      },
    );
    const count = p.container.querySelector('[data-ws="pick-selector-count"]') as HTMLElement;
    expect(count.textContent).toBe('24');
    expect(p.container.querySelector('[data-ws="input"]')!.hasAttribute('data-invalid')).toBe(true);
    expect(p.container.querySelector('[data-ws="pick-selector-error"]')!.textContent).toBe('matches nothing');
    fireEvent.click(p.container.querySelector('[data-ws="pick-selector-pick"]')!);
    expect(picked).toBe(1);
    expect(p.container.querySelector('[data-ws="pick-selector-candidates"]')!.textContent).toBe('6');
    // A typed value is counted live, after a pause.
    fireEvent.change(p.container.querySelector('[data-ws="pick-selector"]')!, { target: { value: 'h2' } });
    expect(count.textContent).toBe('—');
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(counted).toEqual([['css=h2', 'item']]);
    expect(count.textContent).toBe('7');
  });
});

describe('selector chain', () => {
  it('joins the primary selectors from the list parent down, leaving out levels that are not set', () => {
    expect(selectorChain([c('id', 'rso'), c('css', 'div > div'), c('css', 'h3')])).toBe('id=rso » css=div > div » css=h3');
    expect(selectorChain([undefined, c('css', 'article'), c('css', 'h2')])).toBe('css=article » css=h2');
    expect(selectorChain([null, c('css', 'article')])).toBe('css=article');
    expect(selectorChain([undefined, undefined])).toBe('');
  });

  it('shows the stack in the list setup, the Rows section, and the inspector of an item scoped pick', async () => {
    const t = await harness(resultsSnapshot(), emptyDraft({ name: 'search-results', url: RESULTS, vars: [] }), RESULTS);
    await openList(t, byClass(t.page, 'LC20lb', 0));
    const proposed = renderPanel(t.controller.state);
    const p = t.controller.state.proposal!;
    const item = p.proposed.selectors[0]!;
    const chip = (ws: string) => (proposed.q(ws)!.querySelector('[data-ws="chip"]') as HTMLElement).dataset.selector;
    expect([chip('list-row-within'), chip('list-row-item'), chip('list-your-pick')]).toEqual(['id=rso', `${item.strategy}=${item.value}`, `${p.pick!.selector!.strategy}=${p.pick!.selector!.value}`]);
    cleanup();

    await acceptList(t);
    const other = byClass(t.page, 'LC20lb', 3);
    let container = other;
    while (container.attrs.class !== 'Mjj4Yd') container = container.parent!;
    await t.pick(other, pathOf(container));
    const state = t.controller.state;
    expect(state.selected!.scope).toBe('item');
    const confirmed = renderPanel(state);
    const saved = state.draft.tables[0]!.item!.selectors[0]!;
    expect(levels(confirmed.q('rows-stack'))).toEqual([
      ['list', 'id=rso'],
      ['item', `${saved.strategy}=${saved.value}`],
    ]);
    const field = state.selected!.selection.candidates[0]!;
    expect(levels(confirmed.q('pick-inspector-stack'))).toEqual([
      ['list', 'id=rso'],
      ['item', `${saved.strategy}=${saved.value}`],
      ['field', `${field.strategy}=${field.value}`],
    ]);
    expect(confirmed.q('pick-inspector-stack')!.dataset.chain).toBe(`id=rso » ${saved.strategy}=${saved.value} » ${field.strategy}=${field.value}`);
    // Indented, outermost first.
    const indents = confirmed.qa('stack-level').filter((r) => r.closest('[data-ws="pick-inspector-stack"]')).map((r) => r.style.paddingLeft);
    expect(indents).toEqual(['0px', '14px', '28px']);
  });

  it('starts the stack at the item container without a list parent, and shows none for a page scoped pick', async () => {
    const t = await harness(resultsSnapshot(), emptyDraft({ name: 'search-results', url: RESULTS, vars: [] }), RESULTS);
    await openList(t, byClass(t.page, 'LC20lb', 0));
    await t.send({ kind: 'draft.setLevel', level: 'within', by: 'clear' });
    await acceptList(t);
    await t.pick(byClass(t.page, 'gLFyf'));
    const panel = renderPanel(t.controller.state);
    const saved = t.controller.state.draft.tables[0]!.item!.selectors[0]!;
    expect(levels(panel.q('rows-stack'))).toEqual([['item', `${saved.strategy}=${saved.value}`]]);
    expect(panel.q('pick-inspector-stack')).toBeNull();
  });

  it('shows one chip per field row, and the stack does nothing on click', async () => {
    const t = await harness(resultsSnapshot(), emptyDraft({ name: 'search-results', url: RESULTS, vars: [] }), RESULTS);
    await openList(t, byClass(t.page, 'LC20lb', 0));
    await acceptList(t);
    const panel = renderPanel(t.controller.state);
    const row = panel.qa('field')[0]!;
    const chips = Array.from(row.querySelectorAll('[data-ws="chip"]')) as HTMLElement[];
    expect(chips).toHaveLength(1);
    expect(chips[0]!.dataset.level).toBe('field');
    expect(row.querySelector('[data-ws="field-summary"]')!.getAttribute('data-chain')).toMatch(/^id=rso » /);
    const before = panel.sent.length;
    for (const chip of Array.from(panel.q('rows-stack')!.querySelectorAll('[data-ws="chip"]'))) (chip as HTMLElement).click();
    expect(panel.sent.length).toBe(before);
  });
});
