import { useId, useState } from "react";
import type React from "react";

import type { OverviewModel } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import { linkSentence, narratorNote, notAnalyzedNote, overviewHeadline, partialNote, scanNote } from "./map-text.js";
import styles from "./MapView.module.css";

/** The narrative shows this many sentences; the rest sit behind a quiet "More". */
const NARRATIVE_VISIBLE = 2;

export interface MapHeaderProps {
  overview: OverviewModel;
  onSelectComponent(id: string): void;
  /** Rescan after a failed scan (ViewerHost.rescanOverview); the Retry button shows only when it is given. */
  onRetry?: () => void;
  /** The selected component: its link in the narrative uses accent ink. */
  selectedId?: string | null;
  /** Hovering a component link behaves like hovering its card. */
  onHoverComponent?: (id: string | null) => void;
}

/**
 * Headline, a row of quiet notes (partial, imports, scan, narrator), then the collapsible narrative (spec §3.4 "Top";
 * the approved Map header): plain sentences whose component names are links, two sentences, then "More".
 */
export function MapHeader({ overview, onSelectComponent, onRetry, selectedId = null, onHoverComponent }: MapHeaderProps): React.JSX.Element {
  const [open, setOpen] = useState(true);
  // Two viewers can mount at once, so the narrative's id is per header.
  const narrativeId = useId();
  const [more, setMore] = useState(false);
  const sentences = overview.snapshot.narrative?.sentences ?? null;
  const headline = overviewHeadline(overview);
  const partial = partialNote(overview);
  const imports = notAnalyzedNote(overview);
  const scan = scanNote(overview);
  const narrator = narratorNote(overview);
  const shown = sentences === null ? [] : more ? sentences : sentences.slice(0, NARRATIVE_VISIBLE);
  const hasNotes = partial !== null || imports !== null || scan !== null || narrator !== null;
  return (
    <header className={styles.header} data-map-header="">
      <div className={styles.headRow}>
        <Icon name="view-map" size={16} />
        <span className={styles.headline}>{headline.count}</span>
        {headline.languages === null ? null : <span className={styles.languages}>{headline.languages}</span>}
        {sentences === null ? null : (
          <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={open ? narrativeId : undefined} onClick={() => setOpen((value) => !value)}>
            <span>Overview</span>
            <Icon name={open ? "chev-d" : "chev-r"} size={12} />
          </button>
        )}
      </div>
      {hasNotes ? (
        <div className={styles.notes}>
          {partial === null ? null : (
            <span className={styles.note} data-map-note="partial" title="The scan stopped at the 20,000-file cap">
              <Icon name="stack" size={12} />
              <span>{partial}</span>
            </span>
          )}
          {imports === null ? null : (
            <span className={styles.note} data-map-note="imports">
              <Icon name="route" size={12} />
              <span>{imports}</span>
            </span>
          )}
          {scan === null ? null : (
            <span className={styles.note} data-map-note={`scan-${scan.state}`} title={scan.detail ?? undefined}>
              <Icon name={scan.state === "running" ? "clock" : "eyeoff"} size={12} />
              <span>{scan.text}</span>
              {scan.progress === null ? null : (
                <span
                  className={styles.progress}
                  role="progressbar"
                  aria-label="Codebase scan"
                  aria-valuemin={0}
                  aria-valuemax={scan.progress.total}
                  aria-valuenow={Math.min(scan.progress.scanned, scan.progress.total)}
                >
                  <i style={{ width: `${scan.progress.total <= 0 ? 0 : Math.round((100 * Math.min(scan.progress.scanned, scan.progress.total)) / scan.progress.total)}%` }} />
                </span>
              )}
              {scan.state === "failed" && onRetry !== undefined ? (
                <button type="button" className={styles.retry} onClick={onRetry}>
                  Retry
                </button>
              ) : null}
            </span>
          )}
          {narrator === null ? null : (
            <span className={styles.note} data-map-note="narrator">
              <Icon name="brief" size={12} />
              <span>{narrator}</span>
            </span>
          )}
        </div>
      ) : null}
      {sentences !== null && open ? (
        <p id={narrativeId} className={styles.narrative} data-map-narrative="">
          {shown.map((sentence, index) => (
            <span key={index} className={styles.sentence}>
              {linkSentence(sentence, overview).map((part, at) =>
                "componentId" in part ? (
                  <button
                    key={at}
                    type="button"
                    className={"marker" in part ? styles.refMarker : styles.ref}
                    data-map-cite={part.componentId}
                    data-selected={part.componentId === selectedId ? "" : undefined}
                    title={part.text}
                    onClick={() => onSelectComponent(part.componentId)}
                    onPointerEnter={() => onHoverComponent?.(part.componentId)}
                    onPointerLeave={() => onHoverComponent?.(null)}
                  >
                    {part.text}
                  </button>
                ) : (
                  part.text
                ),
              )}{" "}
            </span>
          ))}
          {sentences.length > NARRATIVE_VISIBLE && !more ? (
            <button type="button" className={styles.more} onClick={() => setMore(true)}>
              More
            </button>
          ) : null}
        </p>
      ) : null}
    </header>
  );
}
