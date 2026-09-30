import type { KeyboardEvent } from "react";

import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  displayUntrusted,
  formatDuration,
  formatOffset,
  normalizeCommand,
  truncateMiddle,
  type Chapter,
  type Step,
  type TraceSession,
} from "../../model/index.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON, SIGNAL_ICON } from "../icons/kind-icons.js";
import type { ViewerHost } from "../shell/host.js";
import { ErrorBoundary } from "../shell/ErrorBoundary.js";
import { useAnnounce } from "../shell/LiveRegion.js";
import { useSessionView } from "../shell/session-context.js";
import { useDispatch, useView } from "../state/store.js";
import type { InspectorTab } from "../state/view-state.js";
import { selectionTitle, topFindingOf } from "./finding-copy.js";
import styles from "./Inspector.module.css";
import { buildReviewNote } from "./review-note.js";
import { Summary } from "./Summary.js";

export interface InspectorProps {
  host: ViewerHost;
}

const TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "evidence", label: "Evidence" },
  { id: "raw", label: "Raw" },
];

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function metaLine(step: Step | undefined, chapter: Chapter | undefined): string {
  if (chapter !== undefined) return `${formatOffset(chapter.tMs)} · ${chapter.stepIds.length} steps`;
  if (step === undefined) return "";
  const parts = [formatOffset(step.tMs)];
  if (step.durationMs !== null) parts.push(formatDuration(step.durationMs));
  if (step.command !== undefined) parts.push(truncateMiddle(displayUntrusted(normalizeCommand(step.command.command)), 40));
  else if (step.edit !== undefined) parts.push(truncateMiddle(displayUntrusted(step.edit.path), 40));
  return parts.join(" · ");
}

function Header({
  session,
  index,
  selection,
  step,
  chapter,
}: {
  session: TraceSession | null;
  index: TraceIndex;
  selection: SelectionId | null;
  step: Step | undefined;
  chapter: Chapter | undefined;
}) {
  if (session === null || selection === null) {
    return (
      <div className={styles.header}>
        <div className={styles.tile}>
          <Icon name="list" size={16} />
        </div>
        <div className={styles.headText}>
          <h2 className={styles.title} data-slot="title">
            Session
          </h2>
        </div>
      </div>
    );
  }
  const finding = step === undefined ? null : topFindingOf(session, step);
  const icon: IconName =
    finding !== null
      ? SIGNAL_ICON[finding.ruleId]
      : step !== undefined
        ? KIND_ICON[step.kind]
        : chapter !== undefined
          ? CATEGORY_ICON[chapter.category]
          : "list";
  return (
    <div className={styles.header}>
      <div className={styles.tile} data-tone={finding?.severity === "critical" ? "bad" : "neutral"}>
        <Icon name={icon} size={16} />
      </div>
      <div className={styles.headText}>
        <h2 className={styles.title} data-slot="title">
          {selectionTitle(session, index, selection)}
        </h2>
        <p className={styles.meta}>{metaLine(step, chapter)}</p>
      </div>
    </div>
  );
}

function TabBody({
  tab,
  session,
  index,
  selection,
}: {
  tab: InspectorTab;
  session: TraceSession | null;
  index: TraceIndex;
  selection: SelectionId | null;
}) {
  if (tab === "summary") return <Summary session={session} index={index} selection={selection} />;
  return <p className={styles.muted}>No evidence for this item</p>;
}

function InspectorBody({ host }: InspectorProps) {
  const { session, index } = useSessionView();
  const selection = useView((state) => state.selection);
  const tab = useView((state) => state.inspectorTab);
  const regrouped = useView((state) => state.selectionNote);
  const dispatch = useDispatch();
  const announce = useAnnounce();

  const entry = selection === null ? undefined : index.entry(selection);
  const step = session !== null && entry?.kind === "step" ? session.steps[entry.position] : undefined;
  const chapter = session !== null && entry?.kind === "chapter" ? session.chapters[entry.position] : undefined;
  const hasDiff = step?.edit?.diffSeq !== undefined || (chapter !== undefined && chapter.files.length > 0);
  const canRequest = host.requestChanges !== undefined;

  const onPrimary = async (): Promise<void> => {
    if (session === null || selection === null) return;
    const note = buildReviewNote(session, index, selection);
    if (host.requestChanges !== undefined) {
      await host.requestChanges({ sessionId: session.meta.sessionId, selected: selection, text: note.firstLine });
      announce("Sent to the composer");
      return;
    }
    announce((await copyText(note.markdown)) ? "Review note copied" : "Could not copy the review note");
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const position = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(position + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    if (next === undefined) return;
    dispatch({ type: "inspector/tab", tab: next.id });
    event.currentTarget.querySelector<HTMLElement>(`#tv-tab-${next.id}`)?.focus();
  };

  const regroupedTitle =
    regrouped === null || session === null ? null : (session.chapters.find((item) => item.id === regrouped.to)?.title ?? null);

  return (
    <div className={styles.inspector}>
      <Header session={session} index={index} selection={selection} step={step} chapter={chapter} />
      {regroupedTitle === null ? null : <p className={styles.note}>{`Regrouped into “${regroupedTitle}”`}</p>}
      <div role="tablist" aria-label="Inspector tabs" className={styles.tabs} onKeyDown={onTabKeyDown}>
        {TABS.map((item) => (
          <button
            key={item.id}
            id={`tv-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="tv-inspector-panel"
            tabIndex={tab === item.id ? 0 : -1}
            className={styles.tab}
            onClick={() => dispatch({ type: "inspector/tab", tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        key={selection ?? "none"}
        id="tv-inspector-panel"
        role="tabpanel"
        aria-labelledby={`tv-tab-${tab}`}
        className={styles.body}
      >
        <TabBody tab={tab} session={session} index={index} selection={selection} />
      </div>
      <div className={styles.footer}>
        <button
          type="button"
          className={styles.primary}
          disabled={selection === null || session === null}
          onClick={() => void onPrimary()}
        >
          <Icon name={canRequest ? "reply" : "copy"} size={14} />
          <span>{canRequest ? "Request changes" : "Copy review note"}</span>
        </button>
        {hasDiff ? (
          <button
            type="button"
            className={styles.secondary}
            disabled={selection === null}
            onClick={() => dispatch({ type: "inspector/tab", tab: "evidence" })}
          >
            <Icon name="diff" size={14} />
            <span>Diff</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Wraps itself in its own boundary (lane ruling): the Shell does not wrap regions. */
export function Inspector(props: InspectorProps) {
  return (
    <ErrorBoundary region="Inspector">
      <InspectorBody {...props} />
    </ErrorBoundary>
  );
}
