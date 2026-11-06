import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src';
import { buildOutline, type OutlineOptions } from '../src/agent/outline';
import { snapshotFromHtml } from './snapshot';

const outline = (body: string, options?: OutlineOptions, budget = 5000) =>
  buildOutline(snapshotFromHtml(`<html><head><title>T</title></head><body>${body}</body></html>`), budget, estimateTokens, options);

describe('outline hierarchy indentation (Task 1.1)', () => {
  it('formats top-level elements without indentation', () => {
    const o = outline('<button>Submit</button><a href="/home">Home</a>');
    expect(o.all).toEqual([
      '[e1] button "Submit"',
      '[e2] link "Home" href=/home',
    ]);
  });

  it('indents nested elements with 2 spaces per depth level', () => {
    const html = `
      <div id="wrapper">
        <header>
          <h1>Site Title</h1>
          <nav>
            <a href="/about">About</a>
          </nav>
        </header>
        <main>
          <section>
            <div class="card">
              <button>Action</button>
            </div>
          </section>
        </main>
      </div>
    `;
    const o = outline(html);
    // wrapper is depth 0
    // header is depth 1 -> h1 is depth 2, nav is depth 2 -> a is depth 3
    // main is depth 1 -> section depth 2 -> card depth 3 -> button depth 4
    expect(o.all).toEqual([
      '    [e1] heading "Site Title"',
      '      [e2] link "About" href=/about',
      '        [e3] button "Action"',
    ]);
  });

  it('caps indentation at 16 spaces (depth 8)', () => {
    // 10 levels of nesting
    let html = '<button>Deep Button</button>';
    for (let i = 0; i < 10; i++) {
      html = `<div>${html}</div>`;
    }
    const o = outline(html);
    expect(o.all).toHaveLength(1);
    expect(o.all[0]).toBe(`${' '.repeat(16)}[e1] button "Deep Button"`);
  });
});

describe('outline state rendering (Task 1.2)', () => {
  it('renders aria-expanded="true" and aria-expanded="false"', () => {
    const o = outline(`
      <button aria-expanded="true">Menu Open</button>
      <button aria-expanded="false">Menu Closed</button>
      <button>Normal Button</button>
    `);
    expect(o.all).toEqual([
      '[e1] button "Menu Open" aria-expanded="true"',
      '[e2] button "Menu Closed" aria-expanded="false"',
      '[e3] button "Normal Button"',
    ]);
  });

  it('renders disabled for disabled attribute or aria-disabled="true"', () => {
    const o = outline(`
      <button disabled>Disabled Button</button>
      <input type="text" disabled placeholder="Disabled Input">
      <a href="/link" aria-disabled="true">Disabled Link</a>
      <button aria-disabled="false">Active Button</button>
    `);
    expect(o.all).toEqual([
      '[e1] button "Disabled Button" disabled',
      '[e2] textbox "Disabled Input" value="" disabled placeholder="Disabled Input"',
      '[e3] link "Disabled Link" href=/link disabled',
      '[e4] button "Active Button"',
    ]);
  });

  it('renders placeholder for text inputs and textareas', () => {
    const o = outline(`
      <input type="text" placeholder="Search keywords..." aria-label="Search">
      <textarea placeholder="Write your notes here..."></textarea>
      <input type="text" name="q" placeholder="Query" value="test">
    `);
    expect(o.all).toEqual([
      '[e1] textbox "Search" value="" placeholder="Search keywords..."',
      '[e2] textbox "Write your notes here..." value="" placeholder="Write your notes here..."',
      '[e3] textbox "Query" value="test" placeholder="Query"',
    ]);
  });
});

describe('outline filtering options (Task 1.3)', () => {
  it('interactive: true filters out plain text and headings', () => {
    const html = `
      <h1>Main Heading</h1>
      <p>Introductory paragraph text that would normally be included.</p>
      <button>Click Me</button>
      <h2>Section Heading</h2>
      <a href="/docs">Read Docs</a>
      <p>Another informative text section.</p>
    `;
    const o = outline(html, { interactive: true });
    expect(o.all).toEqual([
      '[e1] button "Click Me"',
      '[e2] link "Read Docs" href=/docs',
    ]);
  });

  it('scope: selector scopes outline to the matched subtree', () => {
    const html = `
      <div id="sidebar">
        <a href="/nav1">Nav 1</a>
        <a href="/nav2">Nav 2</a>
      </div>
      <div id="results">
        <h2>Results</h2>
        <div class="item">
          <a href="/item1">Item 1</a>
          <button>Buy</button>
        </div>
      </div>
    `;
    const o = outline(html, { scope: '#results' });
    expect(o.all).toEqual([
      '[e1] heading "Results"',
      '  [e2] link "Item 1" href=/item1',
      '  [e3] button "Buy"',
    ]);
  });

  it('scope: returns empty outline when selector matches nothing', () => {
    const o = outline('<button>Test</button>', { scope: '#nonexistent' });
    expect(o.all).toEqual([]);
    expect(o.text).toBe('');
  });

  it('depth: limits recursion depth', () => {
    const html = `
      <div id="level0">
        <button>L0 Button</button>
        <div id="level1">
          <button>L1 Button</button>
          <div id="level2">
            <button>L2 Button</button>
            <div id="level3">
              <button>L3 Button</button>
            </div>
          </div>
        </div>
      </div>
    `;
    // depth: 1 stops recursing when depth >= 1.
    // L0 Button is at depth 1 (inside level0 container at depth 0).
    // level1 is at depth 1, so its children are not recursed into.
    const oDepth1 = outline(html, { depth: 1 });
    expect(oDepth1.all).toEqual([
      '  [e1] button "L0 Button"',
    ]);

    // depth: 2 allows recursion into level1 children (depth 2), but not level2 children (depth 3)
    const oDepth2 = outline(html, { depth: 2 });
    expect(oDepth2.all).toEqual([
      '  [e1] button "L0 Button"',
      '    [e2] button "L1 Button"',
    ]);
  });
});
