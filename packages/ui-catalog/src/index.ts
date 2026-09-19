export { jevcodeCatalog } from "./catalog.js";
export type { JevcodeCatalog } from "./catalog.js";
export { registry, handlers, executeAction } from "./registry.js";
export {
  dispatchCatalogAction,
  getActionDispatcher,
  setActionDispatcher,
} from "./actions.js";
export type { ActionDispatcher } from "./actions.js";
export { ChangeOverview } from "./components/ChangeOverview.js";
export { CodeDiff } from "./components/CodeDiff.js";
export { Decision } from "./components/Decision.js";
export { FailureAnalysis } from "./components/FailureAnalysis.js";
export { Terminal } from "./components/Terminal.js";
export { TestMatrix } from "./components/TestMatrix.js";
export { BehaviorDelta } from "./components/BehaviorDelta.js";
export {
  ExecutionTimeline,
  isMilestoneEvent,
  MILESTONE_KIND_LABELS,
} from "./components/ExecutionTimeline.js";
export { SchemaDelta, summarizeSchemaChanges } from "./components/SchemaDelta.js";
export {
  DEPENDENCY_CHILDREN_CONTAINER_ID,
  DependencyDelta,
} from "./components/DependencyDelta.js";
export { ArchitectureDelta } from "./components/ArchitectureDelta.js";
export {
  ARCH_COLUMN_GAP,
  ARCH_ROW_GAP,
  layoutArchitectureNodes,
  nodeKindClass,
} from "./components/architecture-layout.js";
export type { PositionedArchitectureNode } from "./components/architecture-layout.js";
export {
  INTERACTION_LOCK_MS,
  LOW_IMPORTANCE_THRESHOLD,
  MIN_SURFACE_LIFETIME_MS,
  SurfaceManager,
} from "./surface/SurfaceManager.js";
export type {
  PendingSurface,
  ProposeResult,
  SurfaceInput,
  SurfaceManagerOptions,
  SurfaceRecord,
  SurfaceSlot,
} from "./surface/SurfaceManager.js";
export { useSurfaceManager } from "./surface/useSurfaceManager.js";
export type { SurfaceManagerApi } from "./surface/useSurfaceManager.js";
export { mergeSpecPatch, specToPatch } from "./streaming/spec-patch.js";
export { useSpecPatchStream } from "./streaming/useSpecPatchStream.js";
export type { SpecPatchStreamHandle } from "./streaming/useSpecPatchStream.js";
export {
  validateIncomingPatch,
  validateIncomingSpec,
} from "./catalog-validation.js";
export type {
  PatchValidation,
  SpecValidation,
} from "./catalog-validation.js";
