import { describe, expect, it } from 'vitest';
import { emptyDraft, HOST_MESSAGE_KINDS, isInteractiveSession, PAGE_MESSAGE_KINDS, parse, parseHostMessage, parsePageMessage, ProtocolError, type Draft, type HostMessage, type PageMessage, type RecorderState } from '../src';
import { FakeBrowser, h } from '../src/testing';
import { CATALOG } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

const candidate = { strategy: 'testid', value: 'price', stability: 'stable' } as const;

const fp = { tag: 'span', textSample: '$1', attrs: {}, ancestors: ['a'], bbox: { x: 0, y: 0, w: 1, h: 1 } };

const sampleState: RecorderState = {
  url: CATALOG,
  draft: newDraft(),
  selected: null,
  proposal: null,
  levelPick: null,
  editing: null,
  pendingSelect: null,
  selectorError: null,
  urlError: null,
  varError: null,
  pathChecks: {},
  descriptionError: null,
  openedUrl: '',
  repick: null,
  targetEdit: null,
  popups: 0,
  pickTrigger: null,
  panelMode: 'owner',
  popup: false,
  repickContext: null,
  guardContext: null,
  notice: null,
  otherLists: [],
  frame: { path: [2, 1], selectors: [{ strategy: 'id', value: 'app', stability: 'stable' }] },
  test: null,
  saved: null,
  busy: null,
  error: null,
  panel: { collapsed: { recipe: false, flows: false, sequence: true } },
};

const selection = {
  path: [1, 0],
  tag: 'h2',
  role: 'heading',
  name: 'Mouse',
  text: 'Mouse',
  attrs: { class: 'product-title' },
  candidates: [{ ...candidate, count: 24 }],
  fingerprint: fp,
  ancestors: [{ label: 'body', path: [1] }],
  containerPath: null,
  framePath: [2, 1],
  fill: null,
  frame: { selectors: [{ strategy: 'id' as const, value: 'app', stability: 'stable' as const, count: 1 }], fingerprint: fp },
};

function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

describe('protocol', () => {
  const page: PageMessage[] = [
    { kind: 'session.ready', url: CATALOG },
    { kind: 'session.end' },
    { kind: 'picker.hover', path: [1, 0], tag: 'h2' },
    { kind: 'picker.select', url: CATALOG, selection, snapshot: h('html') },
    { kind: 'picker.cancel' },
    { kind: 'selection.clear' },
    { kind: 'selection.setSelector', selector: 'css=h3', scope: 'item', snapshot: h('html') },
    { kind: 'selection.retarget', table: 1 },
    { kind: 'selection.retarget', table: null },
    { kind: 'inspect.count', candidate, scope: 'item' },
    { kind: 'inspect.primary', index: 1 },
    { kind: 'draft.confirmItems' },
    { kind: 'draft.cancelItems' },
    { kind: 'list.open', from: 'suggestion' },
    { kind: 'list.open', from: 'newTable' },
    { kind: 'list.dismiss' },
    { kind: 'list.ladder', which: 'parent' },
    { kind: 'draft.editItem' },
    { kind: 'draft.setLevel', level: 'within', by: 'pick', path: [1, 0, 1] },
    { kind: 'draft.setLevel', level: 'item', by: 'selector', selector: 'role=listitem' },
    { kind: 'draft.setLevel', level: 'within', by: 'clear', snapshot: h('html') },
    { kind: 'draft.setLevel', level: 'item', by: 'path', path: [1, 0, 1, 2] },
    { kind: 'draft.pickLevel', level: 'item' },
    { kind: 'draft.toggleIncludeAll' },
    { kind: 'draft.setPrimary', level: 'item', index: 1 },
    { kind: 'draft.setPrimary', level: 'within', index: 0 },
    { kind: 'draft.clearItem' },
    { kind: 'draft.clearTable' },
    { kind: 'draft.moveFieldToPage', index: 1 },
    { kind: 'draft.addExclusion', selector: '.sponsored' },
    { kind: 'draft.removeExclusion', index: 0 },
    { kind: 'draft.addField', patch: { name: 'price', type: 'number' } },
    { kind: 'draft.updateField', index: 0, patch: { attr: null, key: true } },
    { kind: 'draft.removeField', index: 0 },
    { kind: 'draft.editField', index: 1 },
    { kind: 'draft.editField', index: 0, table: 1 },
    { kind: 'draft.addField', patch: { table: { new: 'page' } } },
    { kind: 'draft.updateEditedField', patch: { name: 'amount', type: 'number', scope: 'item', attr: null, optional: true, key: false } },
    { kind: 'draft.cancelEdit' },
    { kind: 'draft.moveField', from: 0, to: 2 },
    { kind: 'draft.repickTarget', target: 'field', index: 1 },
    { kind: 'target.edit.start', ref: { kind: 'step', flow: 0, index: 1 }, mode: 'pick' },
    { kind: 'target.edit.count', ref: { kind: 'trigger', flow: 0 }, selector: 'css=nav a' },
    { kind: 'target.edit.apply', ref: { kind: 'pagination' }, by: 'selector', selector: 'css=a.next' },
    { kind: 'target.edit.cancel' },
    { kind: 'draft.addStep', step: { kind: 'fill', value: 'mouse' }, selection },
    { kind: 'draft.addStep', step: { kind: 'await-user', until: 'disappears' }, flow: 1 },
    { kind: 'draft.updateStep', index: 0, patch: { value: '{q}', optional: true, label: null, window: 'popup', until: null, timeoutMs: 60000 } },
    { kind: 'draft.updateStep', flow: 1, index: 0, patch: { timeoutMs: null } },
    { kind: 'draft.removeStep', index: 0 },
    { kind: 'draft.moveStep', flow: 0, from: 1, to: 0 },
    { kind: 'draft.replayStep', index: 0 },
    { kind: 'draft.addFlow' },
    { kind: 'draft.addFlow', name: 'login' },
    { kind: 'draft.updateFlow', index: 0, patch: { name: 'setup', trigger: null, maxRetries: 3, recover: true } },
    { kind: 'draft.removeFlow', index: 1 },
    { kind: 'draft.duplicateFlow', index: 0 },
    { kind: 'draft.selectFlow', index: 0 },
    { kind: 'draft.replayFlow', index: 0 },
    { kind: 'draft.pickTrigger', index: 1 },
    { kind: 'draft.pickTrigger', index: null },
    { kind: 'draft.setTrigger', index: 1, selection },
    { kind: 'draft.replayFlowsBefore', table: 0 },
    { kind: 'draft.markPagination' },
    { kind: 'paginate.update', patch: { limit: 3, stopRules: ['no-new-items'], table: 'items' } },
    { kind: 'paginate.update', patch: { table: null } },
    { kind: 'draft.clearPagination' },
    { kind: 'sequence.move', from: [0], to: [1, 0] },
    { kind: 'sequence.customize' },
    { kind: 'sequence.reset' },
    { kind: 'window.activity' },
    { kind: 'draft.addTable', name: 'page' },
    { kind: 'draft.addTable' },
    { kind: 'draft.renameTable', name: 'questions' },
    { kind: 'draft.removeTable' },
    { kind: 'draft.selectTable', index: 1 },
    { kind: 'draft.moveTable', from: 1, to: 0 },
    { kind: 'panel.setCollapsed', section: 'flows', collapsed: true },
    { kind: 'frame.edit', key: { strategy: 'id', value: 'app', stability: 'stable' }, by: 'primary', index: 1 },
    { kind: 'frame.edit', key: { strategy: 'id', value: 'app', stability: 'stable' }, by: 'selector', selector: 'iframe.app' },
    { kind: 'draft.setName', name: 'shop' },
    { kind: 'draft.setDescription', target: { kind: 'table', index: 1 }, text: 'cards' },
    { kind: 'draft.setHumanize', on: true },
    { kind: 'draft.setVar', name: 'tier', value: '1' },
    { kind: 'draft.reopen' },
    { kind: 'draft.setUrl', url: 'http://127.0.0.1:4777/catalog?tier={tier}' },
    { kind: 'draft.addVar', name: 'email' },
    { kind: 'draft.renameVar', from: 'tier', to: 'level' },
    { kind: 'draft.removeVar', name: 'level' },
    { kind: 'draft.setVarKind', name: 'pass', secret: true, type: 'string' },
    { kind: 'vars.checkPath', name: 'video' },
    { kind: 'draft.useCurrentUrl' },
    { kind: 'test.run' },
    { kind: 'test.clear' },
    { kind: 'save.request' },
    { kind: 'repick.confirm' },
    { kind: 'repick.skip' },
    { kind: 'repick.abort' },
    { kind: 'guard.continue' },
    { kind: 'guard.abort' },
  ];
  const host: HostMessage[] = [
    { kind: 'draft.state', state: sampleState },
    { kind: 'inspect.countResult', count: 24 },
    {
      kind: 'test.results',
      results: { tables: [{ name: 'items', rows: [{ _page: 1, _index: 0, title: 'x' }], rowCount: 1, dropped: { count: 0, fields: [] }, fields: [{ name: 'title', status: 'ok' }] }], durationMs: 12, warnings: [] },
      state: sampleState,
    },
    { kind: 'save.result', ok: false, errors: [{ path: '$.fields', message: 'a recipe needs at least one field' }], state: sampleState },
    { kind: 'session.error', message: 'boom' },
    { kind: 'step.replayResult', index: 0, ok: true, message: 'replayed step 1 (click)', state: sampleState },
    { kind: 'session.detach' },
    { kind: 'panel.mode', mode: 'strip', popup: true },
    {
      kind: 'draft.state',
      state: {
        ...sampleState,
        draft: {
          ...newDraft(),
          flows: [
            { name: 'setup', steps: [{ kind: 'click', target: { selectors: [{ ...candidate, count: 1 }] }, window: 'same', optional: false, count: 1 }] },
            { name: 'login-wall', trigger: { selectors: [{ ...candidate, count: 0 }] }, maxRetries: 3, recover: true, steps: [{ kind: 'await-user', target: { selectors: [candidate] }, until: 'disappears', timeoutMs: 1000, window: 'popup', optional: false, label: 'Log in', count: null }] },
          ],
          activeFlow: 1,
          pagination: { kind: 'next', target: { selectors: [candidate] }, limit: 'all', stopRules: [], delayMs: 0, table: 'items' },
          sequence: { custom: true, blocks: [{ flow: 'setup' }, { paginate: { do: [{ extract: 'items' }] } }] },
          sequenceErrors: [{ path: [1, 0], message: 'table "items" is extracted more than once' }, { path: null, message: 'x' }],
        },
        targetEdit: { ref: { kind: 'step', flow: 0, index: 0 }, phase: 'typing', title: 'setup · step 1', strip: 'Picking target for setup · step 1', use: 'Use for step', frame: null, selection: null, primary: 0 },
        popups: 1,
        pickTrigger: 1,
        panelMode: 'owner',
        popup: true,
        guardContext: { kind: 'await-user', label: 'Log in', reason: 'waiting for you', page: 1, url: CATALOG, deadline: 1 },
      },
    },
    {
      kind: 'draft.state',
      state: {
        ...sampleState,
        repick: 0,
        repickContext: { table: 'items', field: 'price', index: 0, oldSelector: candidate, fingerprint: fp, sample: '$1', threshold: 0.7, reason: 'run', picked: { score: 0.91, sample: '$2', selector: candidate } },
      },
    },
    {
      kind: 'draft.state',
      state: {
        ...sampleState,
        levelPick: { level: 'within', ancestorOf: [[1, 0, 1, 2]], ofContainers: false, descendantOf: null, containing: null },
        proposal: {
          within: { tag: 'ul', label: 'ul.product-list', path: [1, 0, 1], selectors: [{ strategy: 'role', value: 'list', stability: 'stable', count: 1 }], primary: 0, count: 1, total: 1, paths: [[1, 0, 1]], samples: [] },
          withinInferred: false,
          proposed: { tag: 'article', label: 'article.card', path: [1, 0, 1, 0, 0], selectors: [{ strategy: 'class', value: 'article.card.kXeqYt', stability: 'fragile', count: 24 }], primary: 0, count: 24, total: 24, paths: [], samples: [] },
          skipped: 6,
          includeAll: false,
          error: { level: 'item', message: 'matches nothing' },
          exclude: [],
          origin: 'edit',
          previousCount: 11,
          pick: { selector: { ...candidate, count: 24, items: 24 }, matched: 24, total: 24 },
          itemLadder: [{ distance: 1, path: [1, 0, 1, 2], selector: null, count: 0, likely: false, sameAs: 2 }],
          parentLadder: [{ distance: 1, path: [1, 0, 1], selector: { ...candidate, count: 1 }, children: 24, likely: true }],
          fieldPreview: [{ name: 'rating', matched: 0, total: 13 }],
        },
      },
    },
    {
      kind: 'draft.state',
      state: {
        ...sampleState,
        selected: {
          selection: { ...selection, candidates: [{ ...candidate, count: 7, items: 7 }] },
          scope: 'item',
          defaults: { name: 'price', type: 'number', table: 0 },
          primary: 0,
          table: 0,
          suggestion: { count: 24, samples: ['a', 'b', 'c'], more: 21 },
          outside: { table: 0, repeats: 9, pageTable: null },
          belongs: { table: 1, index: 0, of: 2, stack: { within: null, item: candidate } },
          frameRefusal: 'the items table reads from iframe#app',
        },
        notice: 'List ready — pick fields inside an item',
        otherLists: [{ table: 1, paths: [[1, 0, 2]] }],
        editing: { index: 0, options: { name: 'price', type: 'number', scope: 'item', optional: true, key: false }, candidates: [{ ...candidate, count: 0, items: 0 }], primary: 0 },
        pendingSelect: { path: [1, 0, 2] },
        selectorError: '"css=.nope" matches nothing',
      },
    },
    {
      kind: 'draft.state',
      state: { ...sampleState, guardContext: { kind: 'login', reason: 'redirected to a login page', page: 1, url: CATALOG, deadline: 1_700_000_000_000 } },
    },
  ];

  it('round-trips every message kind through JSON and parse', () => {
    expect(new Set(page.map((m) => m.kind))).toEqual(new Set(PAGE_MESSAGE_KINDS));
    expect(new Set(host.map((m) => m.kind))).toEqual(new Set(HOST_MESSAGE_KINDS));
    for (const message of [...page, ...host]) {
      const wire = JSON.parse(JSON.stringify(message));
      expect(parse(wire), message.kind).toEqual(message);
    }
    for (const message of page) expect(parsePageMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    for (const message of host) expect(parseHostMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it('defaults the proposal origin to a pick', () => {
    const view = (host.find((m) => m.kind === 'draft.state' && m.state.proposal) as HostMessage & { kind: 'draft.state' }).state.proposal!;
    const { origin: _origin, ...rest } = view;
    const parsed = parseHostMessage(JSON.parse(JSON.stringify({ kind: 'draft.state', state: { ...sampleState, proposal: rest } })));
    expect(parsed.kind === 'draft.state' && parsed.state.proposal!.origin).toBe('pick');
    expect(parsePageMessage({ kind: 'draft.editItem' })).toEqual({ kind: 'draft.editItem' });
  });

  it('rejects malformed messages', () => {
    expect(() => parsePageMessage({ kind: 'draft.moveField', from: -1, to: 0 })).toThrow(ProtocolError);
    expect(() => parse({ kind: 'nope' })).toThrow(/invalid message/);
    expect(() => parseHostMessage({ kind: 'session.ready', url: 'x' })).toThrow(ProtocolError);
  });
});

describe('FakeInteractiveSession', () => {
  it('is an InteractiveSession that records injections, bindings, and dispatches', async () => {
    const browser = new FakeBrowser({ [CATALOG]: tier0Snapshot() });
    const session = await browser.open('/p', { bypassCSP: true });
    expect(isInteractiveSession(session)).toBe(true);
    expect(browser.openOptions[0]).toEqual({ bypassCSP: true });
    const navigations: string[] = [];
    session.onNavigated((url) => navigations.push(url));
    await session.inject('window.x = 1');
    await session.expose('__webscoopHost', async (msg) => ({ echo: msg }));
    await session.goto(CATALOG, { timeoutMs: 1000 });
    await session.dispatch({ kind: 'draft.state' });
    expect(session.injected).toEqual(['window.x = 1']);
    expect(navigations).toEqual([CATALOG]);
    expect(session.dispatchedOf('draft.state')).toHaveLength(1);
    expect(await session.callHost({ kind: 'ping' })).toEqual({ echo: { kind: 'ping' } });
    let closed = 0;
    session.onClosed(() => closed++);
    await session.userClose();
    expect(closed).toBe(1);
    await expect(session.dispatch({})).rejects.toThrow(/closed/);
  });
});
