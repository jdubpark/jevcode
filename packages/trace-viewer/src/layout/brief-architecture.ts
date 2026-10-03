// The Brief's architecture part (spec §3.3 item 3, §8.4). Pure and React-free.
import { overviewStatusOf, type TraceSession } from "../model/index.js";
import type { BriefArchitecture } from "./brief.js";
import { componentForPath } from "./map-layout.js";

function firstSeq(stepIds: readonly string[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const id of stepIds) {
    const seq = Number(id.slice("step:".length));
    if (seq < min) min = seq;
  }
  return min;
}

/**
 * null until an overview_snapshot row arrives (spec §8.1). `touched` lists the components of this session's edited
 * files in order of first edit; `scanning` is the progress of a running scan (ruling R3), else null.
 */
export function briefArchitecture(session: TraceSession): BriefArchitecture | null {
  const overview = session.overview;
  if (overview === null) return null;
  const entities = [...session.entities].sort(
    (a, b) => firstSeq(a.stepIds) - firstSeq(b.stepIds) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const touched: string[] = [];
  const seen = new Set<string>();
  for (const entity of entities) {
    const id = componentForPath(overview, entity.path);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    touched.push(id);
  }
  const narrative = overview.snapshot.narrative;
  const scan = overviewStatusOf(overview.snapshot).scan;
  return {
    overviewSentences: narrative === null ? null : [...narrative.sentences],
    componentCount: overview.snapshot.components.length,
    touched,
    scanning: scan.state === "running" ? { done: scan.scanned, total: scan.total } : null,
  };
}
