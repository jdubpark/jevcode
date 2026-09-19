import { createHash, randomUUID } from "node:crypto";

import type { SymbolKind } from "./evidence.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function newSessionId(): string {
  return newId("sess");
}

export function newChangeUnitId(): string {
  return newId("cu");
}

export function newDecisionId(): string {
  return newId("dec");
}

export function newFactId(): string {
  return newId("fact");
}

export function newSemanticEventId(): string {
  return newId("sem");
}

export function newSurfaceId(
  kind:
    | "changeunit"
    | "decision"
    | "validation"
    | "timeline"
    | "terminal"
    | "completion",
  id: string,
): string {
  return `${kind}:${id}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function symbolId(
  path: string,
  name: string,
  kind: SymbolKind,
  signatureText: string,
): string {
  const hash = createHash("sha1").update(signatureText).digest("hex");
  return `${path}#${name}(${kind})@${hash}`;
}
