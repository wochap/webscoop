import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src';
import type { AgentAction } from '../src/agent/actions';
import { buildOutline } from '../src/agent/outline';
import { classifySubmit } from '../src/agent/submit';
import { snapshotFromHtml } from './snapshot';

const outline = (body: string) => buildOutline(snapshotFromHtml(`<html><head><title>T</title></head><body>${body}</body></html>`), 5000, estimateTokens);
const click = (ref: string): AgentAction => ({ action: 'click', ref, reason: '' });
const enter = (ref?: string): AgentAction => ({ action: 'press', key: 'Enter', ...(ref ? { ref } : {}), reason: '' });

/** Whether `action` on `ref` of `body` would submit; `lastFill` names the ref the step filled last. */
const submits = (body: string, action: AgentAction, lastFill?: string) => {
  const o = outline(body);
  const node = 'ref' in action && action.ref ? o.node(action.ref) : undefined;
  return classifySubmit(node, action, lastFill ? o.node(lastFill) : undefined);
};

describe('submit classification', () => {
  const post = (inner: string) => `<form method="POST" action="/x">${inner}</form>`;
  const get = (inner: string) => `<form method="get" action="/s">${inner}</form>`;

  it('counts a submit control of a POST form, whatever its name', () => {
    expect(submits(post('<button>Continue</button>'), click('e1'))).toBe(true);
    expect(submits(post('<button type="submit">Next</button>'), click('e1'))).toBe(true);
    expect(submits(post('<input type="submit" value="Go">'), click('e1'))).toBe(true);
    expect(submits(post('<input type="image" alt="Go" src="/go.png">'), click('e1'))).toBe(true);
  });

  it('counts a control outside the form that names it with form=', () => {
    expect(submits('<form id="f" method="post"></form><button form="f">Next</button>', click('e1'))).toBe(true);
  });

  it('does not count a plain button of a POST form, or a GET search form', () => {
    expect(submits(post('<button type="button">Show more</button>'), click('e1'))).toBe(false);
    expect(submits(get('<input type="text" placeholder="q"><button>Search</button>'), click('e2'))).toBe(false);
    expect(submits(get('<input type="text" placeholder="q">'), enter('e1'))).toBe(false);
  });

  it('counts Enter in a text field of a POST form, and without a ref after a fill there', () => {
    const body = post('<input type="text" placeholder="Name"><input type="checkbox" aria-label="Agree">');
    expect(submits(body, enter('e1'))).toBe(true);
    expect(submits(body, enter('e2'))).toBe(false);
    expect(submits(body, enter(), 'e1')).toBe(true);
    expect(submits(body, enter())).toBe(false);
    expect(submits(body, { action: 'press', key: 'Tab', ref: 'e1', reason: '' })).toBe(false);
  });

  it('counts a click on a risk word as a whole word, ignoring case', () => {
    expect(submits('<button>Place ORDER</button>', click('e1'))).toBe(true);
    expect(submits('<a href="#">Delete account</a>', click('e1'))).toBe(true);
    expect(submits('<div role="button">Sign up</div>', click('e1'))).toBe(true);
    expect(submits('<button>Payment details</button>', click('e1'))).toBe(false);
    expect(submits('<button>Next page</button>', click('e1'))).toBe(false);
  });
});
