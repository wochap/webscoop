import { execFileSync } from 'node:child_process';
import { currentTable } from '@webscoop/core';
import { dataset } from '@webscoop/playground';
import { expect } from '@playwright/test';
import type { HookState, Recording } from './recorder-fixture';

/** The selector of a panel hook, optionally narrowed with more CSS, such as `[data-table="page"]`. */
export const ws = (name: string, more = '') => `[data-ws="${name}"]${more}`;

/** The rows the reference catalog recipe yields on one page. */
export function expectedRows(baseUrl: string, products = dataset) {
  return products.map((p, index) => ({
    _page: 1,
    _index: index,
    title: p.title,
    price: p.price,
    url: new URL(p.url, baseUrl).href,
    image: new URL(p.image, baseUrl).href,
    rating: p.rating,
  }));
}

/** The command lines of the Chromium processes that use a profile. */
export function chromiumUsing(profileDir: string): string[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.includes(`--user-data-dir=${profileDir}`));
}

/** The playground catalog URL template, with the tier as a variable. */
export const template = (port: number, extra = '') => `http://127.0.0.1:${port}/catalog?tier={tier}${extra}`;

const fieldsOf = (s: HookState) => (s.host ? currentTable(s.host.draft).fields : []);

/** Panel actions and reads for the recorder specs, built on the recording's low-level calls. */
export function sidebar(r: Recording) {
  const panel = {
    ws,

    /** Start picking with `p`, click a page element, and wait for the selection. */
    pick: (selector: string, index = 0, opts: { alt?: boolean } = {}) => r.pick(selector, index, opts),

    /**
     * Pick an element that repeats and open the list setup from its suggestion with `L`.
     * `item` and `parent` type the item container or the list parent into their rows.
     */
    async setUpList(selector: string, opts: { index?: number; item?: string; parent?: string } = {}): Promise<HookState> {
      const picked = await r.pick(selector, opts.index ?? 0);
      expect(picked.mode).toBe('selected');
      expect(picked.host!.selected!.suggestion).not.toBeNull();
      expect(await r.count(ws('pick-cta'))).toBe(1);
      await r.key('l');
      await r.until((s) => s.host?.proposal);
      if (opts.item) {
        const item = opts.item;
        await r.clickPanel(ws('list-row-item'));
        await r.submit(ws('list-input-item'), item);
        await r.until((s) => s.host?.proposal?.proposed.selectors[0]?.value === item.replace(/^css=/, ''));
      }
      if (opts.parent) {
        const parent = opts.parent;
        await r.clickPanel(ws('list-row-within'));
        await r.submit(ws('list-input-within'), parent);
        await r.until((s) => s.host?.proposal?.within?.selectors[0]?.value === parent.replace(/^css=/, ''));
      }
      return r.state();
    },

    /** Set up a list from the product title at `index`, accept it with Enter, and add the title as a field. */
    async titlesAsList(index = 0): Promise<void> {
      await panel.setUpList('h2.product-title', { index });
      await panel.acceptList({ enter: true });
      await panel.addField('title');
    },

    /** Accept the list setup, with the Accept button or with Enter, and wait until the item container is set. */
    async acceptList(opts: { enter?: boolean } = {}): Promise<HookState> {
      const table = (await r.state()).host!.draft.activeTable;
      // Focus may still be in a selector input, where Enter does not accept.
      if (opts.enter) await r.key('Enter');
      else await r.clickPanel(ws('list-accept'));
      const state = await r.until((s) => (s.host?.draft.tables[table]!.item && !s.host.proposal ? s : undefined));
      expect(await r.count(ws('list-setup'))).toBe(0);
      return state;
    },

    /** Add the selection, or first pick `selector`, as a field of the active table named `name`. */
    async addField(name: string, opts: { selector?: string; index?: number } = {}): Promise<void> {
      if (opts.selector) await r.pick(opts.selector, opts.index ?? 0);
      else await r.until((s) => s.host?.selected);
      const before = fieldsOf(await r.state()).length;
      await r.fill(ws('pick-form-name'), name);
      await r.clickPanel(ws('pick-add-field'));
      await r.until((s) => fieldsOf(s).length === before + 1 && fieldsOf(s).at(-1)?.name === name);
    },

    /** Rename a field row of the active table, `last` for the last one, and wait for the host to take it. */
    async renameField(index: number | 'last', name: string): Promise<void> {
      const at = index === 'last' ? (await r.count(ws('field'))) - 1 : index;
      await r.fill(ws('field-name'), name, at);
      await r.until((s) => fieldsOf(s)[at]?.name === name);
    },

    /** Add a table from the strip; it becomes active. */
    async addTable(): Promise<void> {
      const before = (await r.state()).host!.draft.tables.length;
      await r.clickPanel(ws('tab-add'));
      await r.until((s) => s.host?.draft.tables.length === before + 1 && s.host.draft.activeTable === before);
    },

    /** Rename the active table from its menu and wait for the host to take it. */
    async renameTable(name: string): Promise<void> {
      await r.clickPanel(ws('table-menu'));
      await r.clickPanel(ws('table-menu-rename'));
      await r.fill(ws('tab-rename'), name);
      await r.until((s) => s.host && currentTable(s.host.draft).name === name);
    },

    /** Activate a table by clicking its tab. */
    async selectTab(name: string): Promise<void> {
      await r.clickPanel(ws('tab', `[data-table="${name}"]`));
      await r.until((s) => s.host && currentTable(s.host.draft).name === name);
    },

    /** Drag the tab at `from` onto the tab at `to` with the real mouse. */
    async reorderTabs(from: number, to: number): Promise<void> {
      const a = (await r.query(ws('tab'), from))!.rect;
      const b = (await r.query(ws('tab'), to))!.rect;
      await r.page.mouse.move(a.x + a.w / 2, a.y + a.h / 2);
      await r.page.mouse.down();
      await r.page.mouse.move(b.x + 6, b.y + b.h / 2, { steps: 8 });
      await r.page.mouse.move(b.x + 4, b.y + b.h / 2, { steps: 2 });
      await r.page.mouse.up();
    },

    /** The table names on the tabs, in strip order. */
    async tabNames(): Promise<string[]> {
      const count = await r.count(ws('tab'));
      const names: string[] = [];
      for (let i = 0; i < count; i++) names.push((await r.query(ws('tab'), i))!.attrs['data-table']!);
      return names;
    },

    /** Save with Ctrl+S and return the recipe path. */
    async save(): Promise<string> {
      await r.key('Control+s');
      const saved = await r.until((s) => s.host?.saved);
      expect(saved.path).toBeTruthy();
      return saved.path!;
    },

    /** Start a test run from the footer and wait for its results. */
    async testRun() {
      await r.clickPanel(ws('footer-test'));
      return r.until((s) => s.host?.test);
    },

    /** The selector of the chip in a stack row of `level`, optionally only the one of `strategy`. */
    chip: (level: string, strategy?: string) => `${ws('stack-level', `[data-level="${level}"]`)} ${ws('chip', strategy ? `[data-strategy="${strategy}"]` : '')}`,
  };
  return panel;
}
