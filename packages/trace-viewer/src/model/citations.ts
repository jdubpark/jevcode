import type { Citation } from "@jevcode/contracts";

import { displayUntrusted, truncateEnd, truncateMiddle } from "./format.js";
import { resolveStableId } from "./lookup.js";
import { parseStableId, type StableId, type StepId, type TraceSession } from "./types.js";

// What a narrator citation points at in this session (spec §3.3 citation chips, §3.5 "a resolvable
// why"). Labels are display-safe and clipped; `full` is the display-safe full text for tooltips.
// Fact citations do not resolve in v1: TraceSession exposes no fact-id index.

export const CITATION_LABEL_MAX = 28;

export type CitationTarget =
  | { kind: "select"; id: StepId; label: string; full: string }
  | { kind: "component"; componentId: string; label: string; full: string }
  | { kind: "none"; label: string; full: string };

const KIND_WORD: Readonly<Record<Citation["kind"], string>> = {
  component: "component",
  file: "file",
  decision: "decision",
  fact: "evidence",
  step: "step",
};

/** A quoted step or decision clips at its end, as the approved mockup's "Redis is a single…" chip does. */
function select(id: StepId, text: string): CitationTarget {
  return { kind: "select", id, label: truncateEnd(text, CITATION_LABEL_MAX), full: displayUntrusted(text) };
}

/** A file chip names the file (the mockup's "rate-limiter.ts"); the tooltip and accessible name carry the path. */
function fileName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut >= 0 && cut < path.length - 1 ? path.slice(cut + 1) : path;
}

export function resolveCitation(session: TraceSession, citation: Citation): CitationTarget {
  const word = KIND_WORD[citation.kind];
  const none: CitationTarget = { kind: "none", label: word, full: `${word} not in this trace` };
  switch (citation.kind) {
    case "step": {
      if (parseStableId(citation.id)?.kind !== "step") return none;
      const target = resolveStableId(session, citation.id as StableId);
      return target?.kind === "step" ? select(target.step.id, target.step.headline) : none;
    }
    case "decision": {
      const target = resolveStableId(session, `decision:${citation.id}`);
      return target?.kind === "decision" ? select(target.step.id, target.step.decision?.title ?? target.step.headline) : none;
    }
    case "file": {
      const target = resolveStableId(session, `file:${citation.id}`);
      const last = target?.kind === "file" ? target.entity.stepIds.at(-1) : undefined;
      if (target?.kind !== "file" || last === undefined) return none;
      return { kind: "select", id: last, label: truncateMiddle(fileName(target.entity.path), CITATION_LABEL_MAX), full: displayUntrusted(target.entity.path) };
    }
    case "component": {
      const component = session.overview?.componentById.get(citation.id);
      return component === undefined
        ? none
        : { kind: "component", componentId: component.id, label: truncateMiddle(component.name, CITATION_LABEL_MAX), full: displayUntrusted(component.name) };
    }
    case "fact":
      return none;
  }
}
