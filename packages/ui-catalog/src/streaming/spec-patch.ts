import type { JsonRenderSpec, JsonRenderSpecPatch } from "@jevcode/contracts";

// v0 patch semantics: patches ACCUMULATE. Element entries merge over the
// current spec by id and there is no deletion marker — elements removed
// from a later spec stay present in the patched surface until a full swap
// (high-importance propose) replaces the spec. Specs must therefore be
// kept small; deletion semantics are deferred.
export function mergeSpecPatch(
  spec: JsonRenderSpec,
  patch: JsonRenderSpecPatch,
): JsonRenderSpec {
  return {
    root: patch.root ?? spec.root,
    elements: { ...spec.elements, ...patch.elements },
  };
}

export function specToPatch(
  current: JsonRenderSpec,
  next: JsonRenderSpec,
): JsonRenderSpecPatch {
  const patch: JsonRenderSpecPatch = { elements: next.elements };
  if (next.root !== current.root) {
    patch.root = next.root;
  }
  return patch;
}
