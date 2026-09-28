import { parseStableId, type Chapter, type Entity, type Finding, type StableId, type Step, type TraceSession } from "./types.js";

export type ResolvedTarget =
  | { kind: "step"; step: Step }
  | { kind: "unit"; chapter: Chapter }
  | { kind: "decision"; step: Step }
  | { kind: "file"; entity: Entity }
  | { kind: "finding"; finding: Finding };

const indexes = new WeakMap<TraceSession, Map<string, ResolvedTarget>>();

function indexOf(session: TraceSession): Map<string, ResolvedTarget> {
  let index = indexes.get(session);
  if (index !== undefined) return index;
  index = new Map();
  for (const step of session.steps) {
    index.set(step.id, { kind: "step", step });
    if (step.decision !== undefined) index.set(`decision:${step.decision.decisionId}`, { kind: "decision", step });
  }
  for (const chapter of session.chapters) index.set(chapter.id, { kind: "unit", chapter });
  for (const entity of session.entities) index.set(entity.id, { kind: "file", entity });
  for (const finding of session.findings) index.set(finding.id, { kind: "finding", finding });
  indexes.set(session, index);
  return index;
}

/** The object a stable id names in this session, or null. decision:<id> resolves to its one
 *  decision step, which keeps step:<firstSeq> across status changes. */
export function resolveStableId(session: TraceSession, id: StableId): ResolvedTarget | null {
  if (parseStableId(id) === null) return null;
  return indexOf(session).get(id) ?? null;
}
