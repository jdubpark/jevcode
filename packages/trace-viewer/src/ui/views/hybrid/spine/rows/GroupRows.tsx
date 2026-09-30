import type { SpineRow } from "../../../../../layout/spine-rows.js";
import { describeGraphic, displayUntrusted, formatDuration, formatOffset, LANES, pickGraphic, type TraceSession } from "../../../../../model/index.js";
import { Graphic } from "../../../../graphics/Graphic.js";
import { Icon } from "../../../../icons/Icon.js";
import { CATEGORY_ICON, LANE_LABEL } from "../../../../icons/kind-icons.js";
import styles from "../Spine.module.css";
import { SelectionFrame } from "./SelectionFrame.js";

export function GroupRow({
  row,
  session,
  selected = false,
  playhead = false,
  onActivate,
  lineId,
}: {
  row: Extract<SpineRow, { t: "chapter" | "noise" | "elided" }>;
  session: TraceSession;
  selected?: boolean;
  playhead?: boolean;
  onActivate(): void;
  lineId?: string;
}) {
  if (row.t === "chapter") {
    const chapter = session.chapters[row.chapter];
    if (chapter === undefined) return <div className={styles.group} />;
    const graphic = pickGraphic(chapter, session);
    const fullTitle = displayUntrusted(chapter.title);
    return (
      <div className={styles.group} data-selected={selected ? "" : undefined} onClick={onActivate}>
        {selected ? <SelectionFrame /> : null}
        <span className={styles.time} data-playhead={playhead ? "" : undefined}>{formatOffset(chapter.tMs)}</span>
        <span className={styles.node}>
          <Icon name={CATEGORY_ICON[chapter.category]} size={14} />
        </span>
        <span className={styles.graphic}>
          {graphic === null ? null : <Graphic spec={graphic} size="xs" label={describeGraphic(graphic)} />}
        </span>
        {/* The short title reads in the row; the full title is the tooltip and, as hidden text the row's
            aria-labelledby points at, the name. */}
        <span className={styles.line} title={fullTitle}>
          <span aria-hidden="true">{displayUntrusted(chapter.shortTitle ?? chapter.title)}</span>
          <span id={lineId} className={styles.srOnly}>{fullTitle}</span>
        </span>
        <span className={styles.metric}>
          {`${formatDuration(chapter.endTMs - chapter.tMs)} · ${chapter.stepIds.length} steps`}
          {chapter.findingIds.length > 0 ? <Icon name="flag" size={12} title={`${chapter.findingIds.length} findings`} /> : null}
        </span>
      </div>
    );
  }
  const first = session.steps[row.steps[0] ?? -1];
  if (row.t === "noise") {
    // A Chapter-level Jev review group (spec §7.6.3): shield node, gray unless a member is a real problem.
    const jev = row.jev;
    return (
      <div
        className={styles.group}
        data-selected={selected ? "" : undefined}
        onClick={onActivate}
        data-noise=""
        data-jev={jev === undefined ? undefined : ""}
      >
        {selected ? <SelectionFrame /> : null}
        <span className={styles.time} data-playhead={playhead ? "" : undefined}>{first === undefined ? "" : formatOffset(first.tMs)}</span>
        <span className={styles.node} data-tone={jev === undefined ? undefined : jev.tone === "bad" ? "bad" : "neutral"}>
          <Icon name={jev === undefined ? "eyeoff" : "shield"} size={14} />
        </span>
        <span className={styles.graphic} />
        <span id={lineId} className={styles.line}>{row.label}</span>
        <span className={styles.metric}>
          <Icon name="chev-r" size={12} />
        </span>
      </div>
    );
  }
  const total = row.steps.length;
  const parts = [`${total} steps`];
  if (row.byLane.edits > 0) parts.push(`${row.byLane.edits} edits`);
  if (row.byLane.commands > 0) parts.push(`${row.byLane.commands} commands`);
  parts.push(formatDuration(row.spanMs));
  return (
    <div className={styles.group} data-selected={selected ? "" : undefined} onClick={onActivate} data-elided="">
      {selected ? <SelectionFrame /> : null}
      <span className={styles.time} data-playhead={playhead ? "" : undefined}>{first === undefined ? "" : formatOffset(first.tMs)}</span>
      <span className={styles.node}>
        <Icon name="stack" size={14} />
      </span>
      <span className={styles.laneBar} aria-hidden="true">
        {LANES.map((lane) =>
          row.byLane[lane] > 0 ? (
            <span
              key={lane}
              className={styles.laneSegment}
              title={LANE_LABEL[lane]}
              style={{ width: `${(row.byLane[lane] / Math.max(1, total)) * 100}%` }}
            />
          ) : null,
        )}
      </span>
      <span id={lineId} className={styles.line}>{parts.join(" · ")}</span>
      <span className={styles.metric}>
        <Icon name="chev-r" size={12} />
      </span>
    </div>
  );
}
