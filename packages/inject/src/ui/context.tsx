import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Actions, Snapshot, Store } from '../store';

interface RecorderContext {
  store: Store;
  actions: Actions;
  /** Where the results drawer renders; null keeps it inline, for component tests. */
  drawerHost: Element | null;
}

const Context = createContext<RecorderContext | null>(null);

export function RecorderProvider({ children, ...value }: RecorderContext & { children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function useRecorderContext(): RecorderContext {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('recorder components need a RecorderProvider');
  return ctx;
}

export function useSnapshot(): Snapshot {
  const { store } = useRecorderContext();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useActions(): Actions {
  return useRecorderContext().actions;
}

export function useDrawerHost(): Element | null {
  return useRecorderContext().drawerHost;
}
