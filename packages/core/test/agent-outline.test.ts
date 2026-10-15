import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src';
import { buildOutline } from '../src/agent/outline';
import { snapshotFromHtml } from './snapshot';

const outline = (body: string, budget = 5000) => buildOutline(snapshotFromHtml(`<html><head><title>T</title></head><body>${body}</body></html>`), budget, estimateTokens);

describe('agent outline', () => {
  it('lists links and buttons with refs in document order', () => {
    const o = outline('<a href="/q3.pdf">Download PDF</a><button>Export</button>');
    expect(o.all).toEqual(['[e1] link "Download PDF" href=/q3.pdf', '[e2] button "Export"']);
    expect(o.text).toBe(o.all.join('\n'));
  });

  it('leaves out hidden elements and head content', () => {
    const o = outline('<div hidden><button>Secret</button></div><button>Shown</button>');
    expect(o.all).toEqual(['[e1] button "Shown"']);
  });

  it('describes inputs, headings and text', () => {
    const o = outline('<h1>Report</h1><input type="text" placeholder="Email" value="a@b.c"><input type="checkbox" aria-label="Agree" checked><p>Published 2026-03-01</p><input type="hidden" name="x">');
    expect(o.all).toEqual(['[e1] heading "Report"', '[e2] textbox "Email" value="a@b.c"', '[e3] checkbox "Agree" checked', '[e4] text "Published 2026-03-01"']);
  });

  it('numbers the same refs on an unchanged page', () => {
    const html = '<h1>A title</h1><a href="/x">One</a><a href="/y">Two</a><p>Some paragraph</p>';
    expect(outline(html).all).toEqual(outline(html).all);
    expect(outline(html).node('e3')?.attrs.href).toBe('/y');
  });

  it('cuts lines to 120 characters', () => {
    const o = outline(`<button>${'x'.repeat(300)}</button>`);
    expect(o.all[0]!.length).toBeLessThanOrEqual(120);
  });

  it('cuts text first, then headings, keeping interactive lines, and says how many', () => {
    const paragraphs = Array.from({ length: 300 }, (_, i) => `<p>Paragraph number ${i} with filler</p>`).join('');
    const links = Array.from({ length: 5 }, (_, i) => `<a href="/l${i}">Link ${i}</a>`).join('');
    const o = outline(`<h1>Head</h1>${paragraphs}${links}`, 400);
    const shown = o.text.split('\n');
    expect(shown.filter((l) => / link /.test(l))).toHaveLength(5);
    expect(shown.some((l) => / heading /.test(l))).toBe(true);
    expect(shown.at(-1)).toMatch(/^\.\.\. \d+ more lines; use find$/);
    expect(o.cut).toBeGreaterThan(0);
    expect(o.all).toHaveLength(306);
  });

  it('finds lines beyond the cut', () => {
    const paragraphs = Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i}${i === 299 ? ' with pdf inside' : ''}</p>`).join('');
    const o = outline(`${paragraphs}<a href="/files/a.PDF">Get</a>`, 300);
    expect(o.text).not.toContain('pdf inside');
    const found = o.find('pdf');
    expect(found).toHaveLength(2);
    expect(found.some((l) => l.includes('pdf inside'))).toBe(true);
    expect(found.some((l) => l.includes('a.PDF'))).toBe(true);
  });
});
