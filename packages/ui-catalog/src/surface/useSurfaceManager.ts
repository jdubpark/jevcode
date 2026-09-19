import { useEffect, useSyncExternalStore } from "react";

import type { JsonRenderSpecPatch } from "@jevcode/contracts";

import type {
  PendingSurface,
  ProposeResult,
  SurfaceInput,
  SurfaceManager,
  SurfaceRecord,
} from "./SurfaceManager.js";

export interface SurfaceManagerApi {
  primary: SurfaceRecord | null;
  generative: readonly SurfaceRecord[];
  raws: readonly SurfaceRecord[];
  pendingSurface: PendingSurface | null;
  propose: (input: SurfaceInput) => ProposeResult;
  flushDue: (now?: number) => ProposeResult | null;
  applyPatch: (surfaceId: string, patch: JsonRenderSpecPatch) => boolean;
  pin: (surfaceId: string) => boolean;
  unpin: (surfaceId: string) => boolean;
  dismiss: (surfaceId: string) => boolean;
  notifyInteraction: () => void;
  setPointerInside: (inside: boolean) => void;
  setExpansionState: (surfaceId: string, key: string, open: boolean) => void;
  getExpansionState: (surfaceId: string) => Record<string, boolean>;
  setScrollPosition: (surfaceId: string, scrollTop: number) => void;
  getScrollPosition: (surfaceId: string) => number | undefined;
}

export function useSurfaceManager(manager: SurfaceManager): SurfaceManagerApi {
  useSyncExternalStore(manager.subscribe, manager.getVersion, manager.getVersion);

  const pending = manager.getPending();
  const pendingAt = pending?.pendingAt ?? null;

  useEffect(() => {
    if (pendingAt === null) {
      return;
    }
    const delay = Math.max(0, pendingAt - manager.getClock());
    const timer = setTimeout(() => {
      manager.flushDue();
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [manager, pendingAt]);

  return {
    primary: manager.getPrimary(),
    generative: manager.getGenerative(),
    raws: manager.getRaws(),
    pendingSurface: pending,
    propose: manager.propose,
    flushDue: manager.flushDue,
    applyPatch: manager.applyPatch,
    pin: manager.pin,
    unpin: manager.unpin,
    dismiss: manager.dismiss,
    notifyInteraction: manager.notifyInteraction,
    setPointerInside: manager.setPointerInside,
    setExpansionState: manager.setExpansionState,
    getExpansionState: manager.getExpansionState,
    setScrollPosition: manager.setScrollPosition,
    getScrollPosition: manager.getScrollPosition,
  };
}
