import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ComponentType,
} from "react";

import type { SelectionId } from "../../layout/trace-index.js";
import type { IconName } from "../icons/icon-names.js";
import { BUILT_IN_VIEW_KEYS, FIRST_HOST_VIEW_KEY } from "../state/keymap.js";
import { useView } from "../state/store.js";
import type { CanvasCamera, HybridCamera, ViewKind } from "../state/view-state.js";

export interface ZoomPreset {
  id: string;
  label: string;
}

export interface ZoomPort {
  label(): string;
  presets(): readonly ZoomPreset[];
  applyPreset(id: string): void;
  zoomIn(): void;
  zoomOut(): void;
  resetToPreset(): void;
  fitAll(): void;
  fitSelection(): void;
}

export interface ViewPort {
  /** j/k order; an unknown id falls back to its ancestor (step → unit). */
  readingOrder(): readonly SelectionId[];
  reveal(id: SelectionId, options: { animate: boolean }): void;
  captureCamera(): CanvasCamera | HybridCamera | null;
  focusSelected(): void;
  zoom: ZoomPort;
}

export interface ViewPortRegistry {
  register(kind: ViewKind, port: ViewPort): () => void;
  get(kind: ViewKind): ViewPort | undefined;
  /** Views call notify() when their zoom label changes. */
  notify(): void;
  subscribe(listener: () => void): () => void;
  /** Bumped by register, unregister and notify. */
  version(): number;
}

export function createViewPortRegistry(): ViewPortRegistry {
  const ports = new Map<ViewKind, ViewPort>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  return {
    register(kind, port) {
      ports.set(kind, port);
      notify();
      return () => {
        if (ports.get(kind) === port) {
          ports.delete(kind);
          notify();
        }
      };
    },
    get: (kind) => ports.get(kind),
    notify,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}

export const ViewPortRegistryContext = createContext<ViewPortRegistry | null>(null);

export function useViewPortRegistry(): ViewPortRegistry {
  const registry = useContext(ViewPortRegistryContext);
  if (registry === null) throw new Error("useViewPortRegistry must be used inside the trace viewer Shell");
  return registry;
}

export function useRegisterViewPort(kind: ViewKind, port: ViewPort): void {
  const registry = useContext(ViewPortRegistryContext);
  useEffect(() => (registry === null ? undefined : registry.register(kind, port)), [registry, kind, port]);
}

/** The shown view's port; re-renders on register, unregister and notify. */
export function useActiveViewPort(): ViewPort | undefined {
  const registry = useViewPortRegistry();
  const view = useView((state) => state.view);
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  useSyncExternalStore(subscribe, registry.version, registry.version);
  return registry.get(view);
}

export interface ViewProps {
  active: boolean;
}

export interface ViewDefinition {
  kind: ViewKind;
  label: string;
  icon: IconName;
  Component: ComponentType<ViewProps>;
}

/** The views the Shell mounts, in switch order: Console, Canvas, Hybrid, Map, then host views (spec §8.5). */
export const ViewDefinitionsContext = createContext<readonly ViewDefinition[]>([]);

/** Views that are not built in, in registration order. */
export function hostViewsOf(views: readonly ViewDefinition[]): ViewDefinition[] {
  return views.filter((view) => BUILT_IN_VIEW_KEYS[view.kind] === undefined);
}

/** Spec §3.7, §8.6: the number key of a view; null for a host view past key 9 or a kind not in `views`. */
export function viewKeyOf(kind: ViewKind, views: readonly ViewDefinition[]): number | null {
  const builtIn = BUILT_IN_VIEW_KEYS[kind];
  if (builtIn !== undefined) return builtIn;
  const position = hostViewsOf(views).findIndex((view) => view.kind === kind);
  const key = FIRST_HOST_VIEW_KEY + position;
  return position < 0 || key > 9 ? null : key;
}
