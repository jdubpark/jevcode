import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  agentStateLabel,
  displayUntrusted,
  formatDuration,
  formatOffset,
  type Chapter,
  type Finding,
  type Severity,
  type Step,
  type TraceSession,
} from "../../model/index.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON, SIGNAL_ICON } from "../icons/kind-icons.js";
import type { ViewerHost } from "../shell/host.js";
import { ErrorBoundary } from "../shell/ErrorBoundary.js";
import { displaySpanMs } from "../shell/TitleBar.js";
import { useAnnounce } from "../shell/LiveRegion.js";
import { useSessionView } from "../shell/session-context.js";
import { useDispatch, useView, useViewStore } from "../state/store.js";
import type { InspectorTab } from "../state/view-state.js";
import { selectionTitle, topFindingOf } from "./finding-copy.js";
import styles from "./Inspector.module.css";
import { Evidence } from "./Evidence.js";
import { Raw } from "./Raw.js";
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

const SEVERITY_WORD: Record<Severity, string> = { critical: "Critical", warning: "Warning", info: "Info" };

/** Offset (with a clock), duration, then the severity of the finding the title names; the command or path is in Summary. */
function MetaLine({ step, chapter, finding }: { step: Step | undefined; chapter: Chapter | undefined; finding: Finding | null }) {
  const tMs = chapter?.tMs ?? step?.tMs;
  if (tMs === undefined) return null;
  const parts: string[] = [];
  if (chapter !== undefined) parts.push(`${chapter.stepIds.length} steps`);
  else if (step !== undefined && step.durationMs !== null) parts.push(formatDuration(step.durationMs));
  return (
    <p className={styles.metaLine}>
      <Icon name="clock" size={12} className={styles.icon} />
      <span>{formatOffset(tMs)}</span>
      {parts.map((part) => (
        <span key={part}>{`· ${part}`}</span>
      ))}
      {finding === null ? null : (
        <span className={finding.severity === "critical" ? styles.badWord : undefined}>{`· ${SEVERITY_WORD[finding.severity]}`}</span>
      )}
    </p>
  );
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
  // Since V-5 the Shell's RightPanel shows the Brief whenever nothing is selected, so this branch (and Summary's session
  // summary) is unreachable inside the viewer. It stays because the Inspector is a self-contained region whose tests
  // render it without a selection, and the session summary's signal chips and coverage have no other home yet.
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
          {session === null ? null : (
            <p className={styles.metaLine}>
              <Icon name="clock" size={12} className={styles.icon} />
              <span>{formatDuration(displaySpanMs(session))}</span>
              <span>{`· ${agentStateLabel(session.meta.state)}`}</span>
            </p>
          )}
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
        <MetaLine step={step} chapter={chapter} finding={finding} />
      </div>
    </div>
  );
}

function TabBody({
  tab,
  session,
  index,
  selection,
  onRelatedSelect,
}: {
  tab: InspectorTab;
  session: TraceSession | null;
  index: TraceIndex;
  selection: SelectionId | null;
  onRelatedSelect(id: SelectionId): void;
}) {
  if (tab === "summary") {
    return <Summary session={session} index={index} selection={selection} onRelatedSelect={onRelatedSelect} />;
  }
  if (tab === "evidence") return <Evidence selection={selection} />;
  return <Raw selection={selection} />;
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

  const panelRef = useRef<HTMLDivElement>(null);
  const store = useViewStore();
  /** Selection a Related click is heading to; cleared once reached or when the select turned out to be a no-op. */
  const focusPanelFor = useRef<SelectionId | null>(null);
  const sending = useRef(false);
  const [, setSendingTick] = useState(false);

  // After a Related click remounts the keyed panel, keep keyboard focus in the inspector (never on Live rebuilds).
  useEffect(() => {
    const intent = focusPanelFor.current;
    focusPanelFor.current = null;
    if (intent !== null && intent === selection) panelRef.current?.focus();
  }, [selection]);

  const onPrimary = async (): Promise<void> => {
    if (session === null || selection === null || sending.current) return;
    const note = buildReviewNote(session, index, selection);
    if (host.requestChanges !== undefined) {
      sending.current = true;
      setSendingTick(true);
      try {
        await host.requestChanges({ sessionId: session.meta.sessionId, selected: selection, text: note.firstLine });
        announce("Sent to the composer");
      } catch {
        announce("Could not send to the composer");
      } finally {
        sending.current = false;
        setSendingTick(false);
      }
      return;
    }
    announce((await copyText(note.markdown)) ? "Review note copied" : "Could not copy the review note");
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const position = TABS.findIndex((item) => item.id === tab);
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? TABS.length - 1
          : (position + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    const next = TABS[target];
    if (next === undefined) return;
    dispatch({ type: "inspector/tab", tab: next.id });
    event.currentTarget.querySelector<HTMLElement>(`#tv-tab-${next.id}`)?.focus();
  };

  const regroupedEntry = regrouped === null ? undefined : index.entry(regrouped.to);
  const regroupedChapter = session !== null && regroupedEntry?.kind === "chapter" ? session.chapters[regroupedEntry.position] : undefined;
  const regroupedTitle = regroupedChapter === undefined ? null : displayUntrusted(regroupedChapter.title);

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
        ref={panelRef}
        id="tv-inspector-panel"
        tabIndex={tab === "summary" ? -1 : 0}
        role="tabpanel"
        aria-labelledby={`tv-tab-${tab}`}
        className={styles.body}
      >
        <TabBody
          tab={tab}
          session={session}
          index={index}
          selection={selection}
          onRelatedSelect={(id) => {
            focusPanelFor.current = id;
            store.dispatch({ type: "select", id, by: "shell" });
            if (store.get().selection !== id) focusPanelFor.current = null;
          }}
        />
      </div>
      <div className={styles.footer}>
        <button
          type="button"
          className={styles.primary}
          disabled={selection === null || session === null}
          aria-disabled={sending.current || undefined}
          aria-busy={sending.current}
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
