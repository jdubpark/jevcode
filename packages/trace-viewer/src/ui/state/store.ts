import { createContext, useContext, useRef, useSyncExternalStore, type Context } from "react";

import type { TraceIndex } from "../../layout/trace-index.js";
import { reduce, type ViewAction, type ViewState } from "./view-state.js";

export interface ViewStore {
  get(): ViewState;
  /** Stable identity for useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
  dispatch(action: ViewAction): void;
  setIndex(index: TraceIndex): void;
  getIndex(): TraceIndex;
}

export function createViewStore(initial: ViewState, index: TraceIndex): ViewStore {
  let state = initial;
  let current = index;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const dispatch = (action: ViewAction): void => {
    const next = reduce(state, action, current);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => state,
    subscribe,
    dispatch,
    setIndex: (next) => {
      current = next;
    },
    getIndex: () => current,
  };
}

export const ViewStoreContext: Context<ViewStore | null> = createContext<ViewStore | null>(null);

export function useViewStore(): ViewStore {
  const store = useContext(ViewStoreContext);
  if (store === null) throw new Error("useViewStore must be used inside a ViewStoreContext provider");
  return store;
}

/** Selector read; `equal` defaults to Object.is. Selectors return primitives or references held in state. */
export function useView<T>(select: (state: ViewState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const store = useViewStore();
  const cache = useRef<{ state: ViewState; select: (state: ViewState) => T; value: T } | null>(null);
  const getSnapshot = (): T => {
    const state = store.get();
    const previous = cache.current;
    if (previous !== null && previous.state === state && previous.select === select) return previous.value;
    const value = select(state);
    if (previous !== null && equal(previous.value, value)) {
      cache.current = { state, select, value: previous.value };
      return previous.value;
    }
    cache.current = { state, select, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useDispatch(): (action: ViewAction) => void {
  return useViewStore().dispatch;
}
