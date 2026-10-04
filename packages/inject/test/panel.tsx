import './drag-event';
import { fireEvent, render } from '@testing-library/react';
import { vi } from 'vitest';
import { emptyDraft, type Draft, type DraftTable, type PageMessage, type Path, type RecorderState } from '@webscoop/core';
import { byClass, harness } from '../../core/test/recorder-helpers';
import { tier0Snapshot } from '../../core/test/snapshot';
import { Store, type Actions, type UiState } from '../src/store';
import { ScoopRoot } from '../src/ui/App';
import { RecorderProvider } from '../src/ui/context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?cat={category}&tier={tier}', vars: [{ name: 'category', value: 'shoes' }, { name: 'tier', value: '0' }] });
}

/** The draft with its active table's fields or item replaced. */
export function withTable(draft: Draft, patch: Partial<DraftTable>): Draft {
  return { ...draft, tables: draft.tables.map((t, i) => (i === draft.activeTable ? { ...t, ...patch } : t)) };
}

export function baseState(draft: Draft = newDraft(), openedUrl = 'http://127.0.0.1:4777/catalog?cat=shoes&tier=0'): RecorderState {
  return { url: 'http://127.0.0.1:4777/catalog?tier=0', draft, selected: null, proposal: null, levelPick: null, editing: null, pendingSelect: null, selectorError: null, urlError: null, varError: null, pathChecks: {}, descriptionError: null, openedUrl, repick: null, targetEdit: null, popups: 0, pickTrigger: null, panelMode: 'owner', popup: false, repickContext: null, guardContext: null, notice: null, startDownload: null, otherLists: [], frame: null, test: null, saved: null, busy: null, error: null, panel: { collapsed: { recipe: false, flows: false, sequence: true } } };
}

/** Real host states from the controller on the tier 0 fake page. */
export async function hostStates(opts: { sponsored?: number } = {}) {
  const t = await harness(tier0Snapshot(opts), emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] }));
  await t.pick(byClass(t.page, 'product-title', 0));
  const suggested = t.controller.state;
  await t.send({ kind: 'list.open', from: 'suggestion' });
  const proposed = t.controller.state;
  return { t, suggested, proposed };
}

export function renderPanel(host: RecorderState | null, ui: Partial<UiState> = {}) {
  const store = new Store();
  if (host) store.setHost(host);
  store.setUi(ui);
  const sent: PageMessage[] = [];
  const selected: Path[] = [];
  const toasts: string[] = [];
  const actions: Actions = {
    send: async (msg) => {
      sent.push(msg);
    },
    startPicking: () => store.setUi({ picking: true }),
    cancelPicking: () => store.setUi({ picking: false }),
    startBrowsing: () => store.setUi({ browsing: true, picking: false }),
    stopBrowsing: () => store.setUi({ browsing: false }),
    selectPath: (path) => {
      selected.push(path);
    },
    setUi: (patch) => store.setUi(patch),
    toast: (_tone, text) => {
      toasts.push(text);
    },
    dismissToast: () => {},
  };
  const view = render(
    <RecorderProvider store={store} actions={actions} drawerHost={null}>
      <ScoopRoot />
    </RecorderProvider>,
  );
  const q = (ws: string) => view.container.querySelector(`[data-ws="${ws}"]`) as HTMLElement | null;
  const qa = (ws: string) => Array.from(view.container.querySelectorAll(`[data-ws="${ws}"]`)) as HTMLElement[];
  return { ...view, store, sent, selected, toasts, actions, q, qa };
}

/** Choose `value` in a panel dropdown: click its trigger, then the option in the open menu. */
export function chooseOption(trigger: Element, value: string) {
  fireEvent.click(trigger);
  const root = trigger.getRootNode() as Document | ShadowRoot;
  const option = root.querySelector(`[role="option"][data-value="${value}"]`);
  if (!option) throw new Error(`no option ${value}`);
  fireEvent.click(option);
}

/** Give the panel body and the element with the `hook` data-ws fixed rects: the body spans 0 to 400, the card starts at `cardTop` relative to it. */
export function placeCard(hook: string, cardTop: number, cardHeight = 100) {
  const proto = Element.prototype as Element & { getBoundingClientRect(): DOMRect };
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON() {} }) as DOMRect;
  return vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const body = this.closest('.ws-body');
    if (this.matches('.ws-body')) return rect(0, 400);
    if (this.matches(`[data-ws="${hook}"]`)) return rect(cardTop - (body?.scrollTop ?? 0), cardHeight);
    return rect(0, 0);
  });
}
