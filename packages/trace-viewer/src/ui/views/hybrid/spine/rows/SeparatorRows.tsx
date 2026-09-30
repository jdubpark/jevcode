import type { SpineRow } from "../../../../../layout/spine-rows.js";
import { formatDuration, formatOffset, type TraceSession } from "../../../../../model/index.js";
import styles from "../Spine.module.css";

const GAP_TEXT: Record<string, string> = {
  invalid_row: "could not be read",
  unknown_row_type: "has an unknown type",
  out_of_order: "arrived out of order",
  unpaired: "has no completion",
  missing_evidence: "has no evidence",
};

export function SeparatorRow({ row, session, lineId }: { row: Extract<SpineRow, { t: "turn" | "idle" | "gap" }>; session: TraceSession; lineId?: string }) {
  if (row.t === "turn") {
    const turn = session.turns[row.turn];
    return (
      <div id={lineId} className={styles.separator}>
        {turn === undefined ? "Turn" : `Turn ${turn.index + 1} · ${turn.trigger} · ${formatOffset(turn.tMs)}`}
      </div>
    );
  }
  if (row.t === "idle") {
    return (
      <div id={lineId} className={styles.separator}>
        {`⋯ ${formatDuration(row.ms)} · ${row.reason === "awaiting_supervisor" ? "waiting for supervisor" : "agent quiet"}`}
      </div>
    );
  }
  const gap = session.gaps[row.gap];
  return (
    <div id={lineId} className={styles.separator}>
      {gap === undefined ? "A row is missing" : `1 row ${GAP_TEXT[gap.kind] ?? "is missing"} · seq ${gap.atSeq}`}
    </div>
  );
}
