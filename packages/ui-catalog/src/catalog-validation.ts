import {
  CATALOG_COMPONENT_NAMES,
  JsonRenderSpecPatchSchema,
  JsonRenderSpecSchema,
  type JsonRenderSpec,
  type JsonRenderSpecPatch,
} from "@jevcode/contracts";

const COMPONENT_NAME_SET = new Set<string>(CATALOG_COMPONENT_NAMES);

export type SpecValidation =
  | { ok: true; spec: JsonRenderSpec }
  | { ok: false; error: string };

export type PatchValidation =
  | { ok: true; patch: JsonRenderSpecPatch }
  | { ok: false; error: string };

/**
 * Closed-catalog validation for specs arriving over ui:spec: structural
 * zod check plus a component-name allowlist. The catalog is closed — no
 * dynamic component registration from model output — so any element whose
 * type is not a SPEC 9.2 catalog component invalidates the whole spec and
 * must be dropped by the caller.
 */
export function validateIncomingSpec(raw: unknown): SpecValidation {
  const structural = JsonRenderSpecSchema.safeParse(raw);
  if (!structural.success) {
    return {
      ok: false,
      error: `invalid spec structure: ${structural.error.message}`,
    };
  }
  for (const [id, element] of Object.entries(structural.data.elements)) {
    if (!COMPONENT_NAME_SET.has(element.type)) {
      return {
        ok: false,
        error: `unknown component type "${element.type}" in element "${id}"`,
      };
    }
  }
  return { ok: true, spec: structural.data };
}

export function validateIncomingPatch(raw: unknown): PatchValidation {
  const structural = JsonRenderSpecPatchSchema.safeParse(raw);
  if (!structural.success) {
    return {
      ok: false,
      error: `invalid patch structure: ${structural.error.message}`,
    };
  }
  for (const [id, element] of Object.entries(structural.data.elements)) {
    if (!COMPONENT_NAME_SET.has(element.type)) {
      return {
        ok: false,
        error: `unknown component type "${element.type}" in patched element "${id}"`,
      };
    }
  }
  return { ok: true, patch: structural.data };
}
