// Browser-safe: no node: imports. Web Crypto's randomUUID is global in Node >= 19 and every
// browser this code targets. Node-only helpers live in node.ts (@jevcode/contracts/node).
export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
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
