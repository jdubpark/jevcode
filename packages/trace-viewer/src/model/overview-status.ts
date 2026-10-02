import type { OverviewSnapshot, OverviewStatus } from "@jevcode/contracts";

/**
 * Ruling R3: the snapshot's status, or the default for rows written without one: the scan is done, and the narrator is
 * pending while any component has no purpose, else ready.
 */
export function overviewStatusOf(snapshot: OverviewSnapshot): OverviewStatus {
  if (snapshot.status !== undefined) return snapshot.status;
  return {
    scan: { state: "done", scanned: snapshot.counts.files, total: snapshot.counts.totalFiles ?? snapshot.counts.files },
    narrator: snapshot.components.some((component) => component.purpose === null) ? "pending" : "ready",
  };
}
