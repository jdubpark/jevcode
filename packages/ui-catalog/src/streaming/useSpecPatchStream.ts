import { useCallback, useRef, useState } from "react";

import { createSpecStreamCompiler } from "@json-render/core";
import type { SpecStreamCompiler, SpecStreamLine } from "@json-render/core";

import type { JsonRenderSpec, JsonRenderSpecPatch } from "@jevcode/contracts";

import { mergeSpecPatch } from "./spec-patch.js";

export interface SpecPatchStreamHandle {
  spec: JsonRenderSpec;
  applyPatchPayload: (patch: JsonRenderSpecPatch) => JsonRenderSpec;
  pushStreamChunk: (chunk: string) => SpecStreamLine[];
}

export function useSpecPatchStream(initial: JsonRenderSpec): SpecPatchStreamHandle {
  const [spec, setSpec] = useState<JsonRenderSpec>(initial);
  const specRef = useRef<JsonRenderSpec>(initial);
  const compilerRef = useRef<SpecStreamCompiler<JsonRenderSpec> | undefined>(
    undefined,
  );
  if (compilerRef.current === undefined) {
    compilerRef.current = createSpecStreamCompiler<JsonRenderSpec>(
      structuredClone(initial),
    );
  }

  const applyPatchPayload = useCallback(
    (patch: JsonRenderSpecPatch): JsonRenderSpec => {
      const next = mergeSpecPatch(specRef.current, patch);
      specRef.current = next;
      compilerRef.current?.reset(structuredClone(next));
      setSpec(next);
      return next;
    },
    [],
  );

  const pushStreamChunk = useCallback((chunk: string): SpecStreamLine[] => {
    const compiler = compilerRef.current;
    if (compiler === undefined) {
      return [];
    }
    const { result, newPatches } = compiler.push(chunk);
    if (newPatches.length > 0) {
      specRef.current = result;
      setSpec(result);
    }
    return newPatches;
  }, []);

  return { spec, applyPatchPayload, pushStreamChunk };
}
