import { render } from '@testing-library/react';
import { emptyDraft, type Draft, type PageMessage, type Path, type RecorderState } from '@webscoop/core';
import { byClass, harness } from '../../core/test/recorder-helpers';
import { tier0Snapshot } from '../../core/test/snapshot';
import { Store, type Actions, type UiState } from '../src/store';
import { ScoopRoot } from '../src/ui/App';
import { RecorderProvider } from '../src/ui/context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function newDraft(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?cat={category}&tier={tier}', vars: [{ name: 'category', value: 'shoes' }, { name: 'tier', value: '0' }] });
}

export function baseState(draft: Draft = newDraft()): RecorderState {
  return { url: 'http://127.0.0.1:4777/catalog?tier=0', draft, selected: null, proposal: null, levelPick: null, editing: null, pendingSelect: null, selectorError: null, repick: null, repickStep: null, repickContext: null, guardContext: null, test: null, saved: null, busy: null, error: null };
}

/** Real host states from the controller on the tier 0 fake page. */
export async function hostStates(opts: { sponsored?: number } = {}) {
  const t = await harness(tier0Snapshot(opts), emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] }));
  await t.pick(byClass(t.page, 'product-title', 0));
  const proposed = t.controller.state;
  return { t, proposed };
}

export function renderPanel(host: RecorderState | null, ui: Partial<UiState> = {}) {
  const store = new Store();
  if (host) store.setHost(host);
  store.setUi(ui);
  const sent: PageMessage[] = [];
  const selected: Path[] = [];
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
    toast: () => {},
    dismissToast: () => {},
  };
  const view = render(
    <RecorderProvider store={store} actions={actions} drawerHost={null}>
      <ScoopRoot />
    </RecorderProvider>,
  );
  const q = (ws: string) => view.container.querySelector(`[data-ws="${ws}"]`) as HTMLElement | null;
  const qa = (ws: string) => Array.from(view.container.querySelectorAll(`[data-ws="${ws}"]`)) as HTMLElement[];
  return { ...view, store, sent, selected, actions, q, qa };
}
