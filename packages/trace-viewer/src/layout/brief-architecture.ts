// The Brief's architecture part (spec §3.3 item 3, §8.4). Pure and React-free.
import { overviewStatusOf, type Entity, type OverviewModel, type TraceSession } from "../model/index.js";
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

/** firstSeq of an entity's steps; finalize keeps an unchanged Entity the same object (spec §6.4). */
const firstSeqByEntity = new WeakMap<Entity, number>();

function entityFirstSeq(entity: Entity): number {
  let seq = firstSeqByEntity.get(entity);
  if (seq === undefined) firstSeqByEntity.set(entity, (seq = firstSeq(entity.stepIds)));
  return seq;
}

/** The last `touched` list per overview. */
const touchedByOverview = new WeakMap<OverviewModel, string[]>();

/**
 * The previous list when it has the same ids in the same order, so a commit that touches no new component keeps the
 * array, and the memoized Brief thumbnail skips it (lane 06 fix, minor 7). A new snapshot is a new overview and starts over.
 */
function stableTouched(overview: OverviewModel, touched: string[]): string[] {
  const previous = touchedByOverview.get(overview);
  if (previous !== undefined && previous.length === touched.length && previous.every((id, at) => id === touched[at])) return previous;
  touchedByOverview.set(overview, touched);
  return touched;
}

/** The inputs of the last part built: it reads only the overview and the entities. */
let last: { overview: OverviewModel; entities: readonly Entity[]; architecture: BriefArchitecture } | null = null;

/**
 * null until an overview_snapshot row arrives (spec §8.1). `touched` lists the components of this session's edited
 * files in order of first edit; `scanning` is the progress of a running scan (ruling R3), else null. A commit that
 * changes neither the overview nor the entities (finalize keeps both the same objects) gets the previous part.
 */
export function briefArchitecture(session: TraceSession): BriefArchitecture | null {
  const overview = session.overview;
  if (overview === null) return null;
  if (last !== null && last.overview === overview && last.entities === session.entities) return last.architecture;
  const entities = [...session.entities].sort(
    (a, b) => entityFirstSeq(a) - entityFirstSeq(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
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
  const architecture: BriefArchitecture = {
    overviewSentences: narrative === null ? null : [...narrative.sentences],
    componentCount: overview.snapshot.components.length,
    touched: stableTouched(overview, touched),
    scanning: scan.state === "running" ? { done: scan.scanned, total: scan.total } : null,
  };
  last = { overview, entities: session.entities, architecture };
  return architecture;
}
