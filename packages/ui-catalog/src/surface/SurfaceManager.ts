import type { JsonRenderSpec, JsonRenderSpecPatch } from "@jevcode/contracts";

import { mergeSpecPatch, specToPatch } from "../streaming/spec-patch.js";

export const MIN_SURFACE_LIFETIME_MS = 8_000;
export const INTERACTION_LOCK_MS = 2_000;
export const LOW_IMPORTANCE_THRESHOLD = 0.5;

export type SurfaceSlot = "generative" | "raw" | "terminal";

export interface SurfaceRecord {
  id: string;
  slot: SurfaceSlot;
  spec: JsonRenderSpec;
  pinned: boolean;
  userOpened: boolean;
  importance: number;
  createdAt: number;
}

export interface SurfaceInput {
  id: string;
  spec: JsonRenderSpec;
  slot?: SurfaceSlot;
  pinned?: boolean;
  userOpened?: boolean;
  importance?: number;
}

export type ProposeResult =
  | { status: "applied"; surfaceId: string; slot: SurfaceSlot }
  | { status: "patched"; surfaceId: string }
  | { status: "deferred"; surfaceId: string; pendingAt: number | null };

export interface PendingSurface {
  input: SurfaceInput;
  pendingAt: number | null;
}

export interface SurfaceManagerOptions {
  minLifetimeMs?: number;
  interactionLockMs?: number;
  lowImportanceThreshold?: number;
  now?: () => number;
}

interface ReplacementBlock {
  pendingAt: number | null;
}

export class SurfaceManager {
  private generativeSurfaces: SurfaceRecord[] = [];
  private rawSurfaces: SurfaceRecord[] = [];
  // Single pending slot by design: when several replacements are deferred
  // while one surface is blocked, only the most recent input is kept
  // (latest-wins) and earlier deferred inputs are dropped.
  private pendingSurface: PendingSurface | null = null;
  private expansionState = new Map<string, Record<string, boolean>>();
  private scrollPositions = new Map<string, number>();
  private pointerInside = false;
  private lastInteractionAt = Number.NEGATIVE_INFINITY;
  private listeners = new Set<() => void>();
  private version = 0;

  private readonly minLifetimeMs: number;
  private readonly interactionLockMs: number;
  private readonly lowImportanceThreshold: number;
  private readonly clock: () => number;

  constructor(options: SurfaceManagerOptions = {}) {
    this.minLifetimeMs = options.minLifetimeMs ?? MIN_SURFACE_LIFETIME_MS;
    this.interactionLockMs = options.interactionLockMs ?? INTERACTION_LOCK_MS;
    this.lowImportanceThreshold =
      options.lowImportanceThreshold ?? LOW_IMPORTANCE_THRESHOLD;
    this.clock = options.now ?? (() => Date.now());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  getClock = (): number => this.clock();

  getPrimary = (): SurfaceRecord | null =>
    this.generativeSurfaces[0] ?? null;

  getGenerative = (): readonly SurfaceRecord[] => [
    ...this.generativeSurfaces,
  ];

  getRaws = (): readonly SurfaceRecord[] => [...this.rawSurfaces];

  getPending = (): PendingSurface | null =>
    this.pendingSurface === null ? null : { ...this.pendingSurface };

  propose = (input: SurfaceInput): ProposeResult => {
    const slot = input.slot ?? "generative";
    const importance = input.importance ?? LOW_IMPORTANCE_THRESHOLD;
    const now = this.clock();

    if (slot === "raw" || slot === "terminal" || input.userOpened === true) {
      return this.proposePersistent(input, slot, importance, now);
    }

    const existing = this.findSurface(input.id);
    if (existing !== undefined) {
      // Interaction lock and pinning apply to high-importance same-id swaps
      // too: a pinned or actively-viewed surface keeps its spec until the
      // block clears (deferred, flushed by unpin/pointer-leave/flushDue).
      // Low-importance same-id updates stay non-destructive patches.
      if (
        existing.slot === "generative" &&
        importance >= this.lowImportanceThreshold
      ) {
        const block = this.sameIdReplacementBlock(existing, now);
        if (block) {
          this.pendingSurface = { input, pendingAt: null };
          this.emit();
          return {
            status: "deferred",
            surfaceId: input.id,
            pendingAt: null,
          };
        }
      }
      return this.updateExisting(existing, input, importance, now);
    }

    const candidate = this.evictionCandidate();
    if (candidate !== undefined) {
      const block = this.replacementBlock(candidate, now);
      if (block !== null) {
        this.pendingSurface = { input, pendingAt: block.pendingAt };
        this.emit();
        return {
          status: "deferred",
          surfaceId: input.id,
          pendingAt: block.pendingAt,
        };
      }
    }
    this.insertGenerative(input, importance, now, candidate);
    this.emit();
    return { status: "applied", surfaceId: input.id, slot: "generative" };
  };

  flushDue = (now: number = this.clock()): ProposeResult | null => {
    if (this.pendingSurface === null) {
      return null;
    }
    const { input } = this.pendingSurface;
    const existing = this.findSurface(input.id);
    if (existing !== undefined) {
      const importance = input.importance ?? LOW_IMPORTANCE_THRESHOLD;
      if (
        existing.slot === "generative" &&
        importance >= this.lowImportanceThreshold &&
        this.sameIdReplacementBlock(existing, now)
      ) {
        this.pendingSurface = { input, pendingAt: null };
        return null;
      }
      this.pendingSurface = null;
      return this.updateExisting(existing, input, importance, now);
    }
    const candidate = this.evictionCandidate();
    if (candidate === undefined) {
      this.pendingSurface = null;
      this.insertGenerative(input, input.importance ?? LOW_IMPORTANCE_THRESHOLD, now, undefined);
      this.emit();
      return { status: "applied", surfaceId: input.id, slot: "generative" };
    }
    const block = this.replacementBlock(candidate, now);
    if (block !== null) {
      this.pendingSurface = { input, pendingAt: block.pendingAt };
      return null;
    }
    this.pendingSurface = null;
    this.insertGenerative(input, input.importance ?? LOW_IMPORTANCE_THRESHOLD, now, candidate);
    this.emit();
    return { status: "applied", surfaceId: input.id, slot: "generative" };
  };

  applyPatch = (surfaceId: string, patch: JsonRenderSpecPatch): boolean => {
    const record = this.findSurface(surfaceId);
    if (record === undefined) {
      return false;
    }
    record.spec = mergeSpecPatch(record.spec, patch);
    this.emit();
    return true;
  };

  pin = (surfaceId: string): boolean => {
    const record = this.findSurface(surfaceId);
    if (record === undefined) {
      return false;
    }
    if (!record.pinned) {
      record.pinned = true;
      this.emit();
    }
    return true;
  };

  unpin = (surfaceId: string): boolean => {
    const record = this.findSurface(surfaceId);
    if (record === undefined) {
      return false;
    }
    if (record.pinned) {
      record.pinned = false;
      this.emit();
    }
    this.flushDue();
    return true;
  };

  dismiss = (surfaceId: string): boolean => {
    const generativeIndex = this.generativeSurfaces.findIndex(
      (s) => s.id === surfaceId,
    );
    let removed = false;
    if (generativeIndex !== -1) {
      this.generativeSurfaces.splice(generativeIndex, 1);
      removed = true;
    }
    const rawIndex = this.rawSurfaces.findIndex((s) => s.id === surfaceId);
    if (rawIndex !== -1) {
      this.rawSurfaces.splice(rawIndex, 1);
      removed = true;
    }
    if (removed) {
      this.emit();
    }
    this.flushDue();
    return removed;
  };

  notifyInteraction = (): void => {
    this.lastInteractionAt = this.clock();
  };

  setPointerInside = (inside: boolean): void => {
    if (this.pointerInside === inside) {
      return;
    }
    this.pointerInside = inside;
    if (!inside) {
      this.flushDue();
    }
  };

  setExpansionState = (surfaceId: string, key: string, open: boolean): void => {
    const state = this.expansionState.get(surfaceId) ?? {};
    state[key] = open;
    this.expansionState.set(surfaceId, state);
  };

  getExpansionState = (surfaceId: string): Record<string, boolean> => ({
    ...(this.expansionState.get(surfaceId) ?? {}),
  });

  setScrollPosition = (surfaceId: string, scrollTop: number): void => {
    this.scrollPositions.set(surfaceId, scrollTop);
  };

  getScrollPosition = (surfaceId: string): number | undefined =>
    this.scrollPositions.get(surfaceId);

  private proposePersistent(
    input: SurfaceInput,
    slot: SurfaceSlot,
    importance: number,
    now: number,
  ): ProposeResult {
    const resolvedSlot = slot === "terminal" ? "terminal" : "raw";
    const existing = this.rawSurfaces.find((s) => s.id === input.id);
    if (existing !== undefined) {
      existing.spec = input.spec;
      existing.importance = importance;
      if (input.pinned !== undefined) {
        existing.pinned = input.pinned;
      }
      this.emit();
      return { status: "applied", surfaceId: input.id, slot: resolvedSlot };
    }
    this.rawSurfaces.push({
      id: input.id,
      slot: resolvedSlot,
      spec: input.spec,
      pinned: input.pinned ?? false,
      userOpened: true,
      importance,
      createdAt: now,
    });
    this.emit();
    return { status: "applied", surfaceId: input.id, slot: resolvedSlot };
  }

  private updateExisting(
    existing: SurfaceRecord,
    input: SurfaceInput,
    importance: number,
    now: number,
  ): ProposeResult {
    if (importance < this.lowImportanceThreshold) {
      const patch = specToPatch(existing.spec, input.spec);
      existing.spec = mergeSpecPatch(existing.spec, patch);
      existing.importance = importance;
      this.emit();
      return { status: "patched", surfaceId: input.id };
    }
    existing.spec = input.spec;
    existing.importance = importance;
    existing.createdAt = now;
    if (input.pinned !== undefined) {
      existing.pinned = input.pinned;
    }
    this.emit();
    return { status: "applied", surfaceId: input.id, slot: existing.slot };
  }

  private insertGenerative(
    input: SurfaceInput,
    importance: number,
    now: number,
    evict: SurfaceRecord | undefined,
  ): void {
    if (evict !== undefined) {
      const index = this.generativeSurfaces.indexOf(evict);
      if (index !== -1) {
        this.generativeSurfaces.splice(index, 1);
      }
    }
    this.generativeSurfaces.unshift({
      id: input.id,
      slot: "generative",
      spec: input.spec,
      pinned: input.pinned ?? false,
      userOpened: input.userOpened ?? false,
      importance,
      createdAt: now,
    });
  }

  private evictionCandidate(): SurfaceRecord | undefined {
    for (let i = this.generativeSurfaces.length - 1; i >= 0; i -= 1) {
      const surface = this.generativeSurfaces[i];
      if (surface !== undefined && !surface.pinned && !surface.userOpened) {
        return surface;
      }
    }
    return undefined;
  }

  private replacementBlock(
    candidate: SurfaceRecord,
    now: number,
  ): ReplacementBlock | null {
    if (candidate.pinned || candidate.userOpened) {
      return { pendingAt: null };
    }
    let pendingAt: number | null = null;
    const lifetimeExpiry = candidate.createdAt + this.minLifetimeMs;
    if (now < lifetimeExpiry) {
      pendingAt = lifetimeExpiry;
    }
    if (
      this.pointerInside ||
      now - this.lastInteractionAt < this.interactionLockMs
    ) {
      return { pendingAt };
    }
    return pendingAt === null ? null : { pendingAt };
  }

  private sameIdReplacementBlock(
    existing: SurfaceRecord,
    now: number,
  ): boolean {
    // Same-id swaps are content refreshes of a surface the user is already
    // viewing, so only pinning and the interaction lock defer them; the
    // minimum lifetime does not apply (it would stall rapid refinements).
    return (
      existing.pinned ||
      this.pointerInside ||
      now - this.lastInteractionAt < this.interactionLockMs
    );
  }

  private findSurface(surfaceId: string): SurfaceRecord | undefined {
    return (
      this.generativeSurfaces.find((s) => s.id === surfaceId) ??
      this.rawSurfaces.find((s) => s.id === surfaceId)
    );
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
