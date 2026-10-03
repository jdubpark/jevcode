import { useEffect, useState } from "react";

import type { AgentState, TraceSessionSummary } from "@jevcode/contracts";

import { agentStateLabel, displayUntrusted, formatDuration, type GapKind, type TraceSession } from "../../model/index.js";
import { Icon } from "../icons/Icon.js";
import { useDispatch, useView } from "../state/store.js";
import { selectNewCount } from "../state/view-state.js";
import { useActiveViewPort } from "../views/view-port.js";
import type { DataStatus } from "./data-controller.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { useSessionView } from "./session-context.js";
import styles from "./TitleBar.module.css";
import { usePopoverDismissal } from "./use-popover.js";
import { ViewSwitch } from "./ViewSwitch.js";

export interface TitleBarProps {
  onRetry(): void;
  /** "embedded": no repo, prompt or duration; the main window header shows them (spec §8.5). Default "full". */
  chrome?: "full" | "embedded";
  /** false when the host places the view switcher itself (TraceViewerProps.renderSwitch). Default true. */
  showSwitch?: boolean;
}

const GAP_LABEL: Record<GapKind, string> = {
  invalid_row: "row could not be read",
  unknown_row_type: "unknown row type",
  out_of_order: "row out of order",
  unpaired: "start without completion",
  missing_evidence: "missing evidence",
};

/** Spec §7.1: max over steps of (tMs + (durationMs ?? 0)); never endedAt − startedAt. */
export function displaySpanMs(session: TraceSession): number {
  let max = 0;
  for (const step of session.steps) max = Math.max(max, step.tMs + (step.durationMs ?? 0));
  return max;
}

/** Header placeholder while the session has no prompt yet. */
const WAITING_FOR_PROMPT = "Waiting for the first prompt";

function firstLine(text: string): string {
  const end = text.search(/\r?\n/);
  return end < 0 ? text : text.slice(0, end);
}

/** The meta's status; empty once terminal, because the disabled Live segment already names the final state (spec §7.1). */
function statusText(
  status: DataStatus,
  loadedFraction: number,
  summary: TraceSessionSummary | null,
  state: AgentState | undefined,
  terminal: boolean,
): string {
  switch (status.kind) {
    case "loading":
      return summary === null ? "Loading" : `Loading ${Math.floor(loadedFraction * 100)}%`;
    case "reconnecting":
      return `Reconnecting (${status.attempt})`;
    case "error":
      return `${status.channel}: ${status.message}`;
    case "ready":
      if (loadedFraction < 1) return `Loading ${Math.floor(loadedFraction * 100)}%`;
      return state === undefined || terminal ? "" : agentStateLabel(state);
  }
}

function TitleBarBody({ onRetry, chrome = "full", showSwitch = true }: TitleBarProps) {
  const { summary, session, index, status, loadedFraction, terminal, nowT } = useSessionView();
  const embedded = chrome === "embedded";
  const dispatch = useDispatch();
  const follow = useView((state) => state.follow);
  const hasSelection = useView((state) => state.selection !== null);
  const briefPinned = useView((state) => state.brief);
  const lastSeenSeq = useView((state) => state.lastSeenSeq);
  const stepCount = useView((state) => selectNewCount(state, index));
  const port = useActiveViewPort();
  // The active view's own count when it has one (the Console counts rows), so both pills agree.
  const newCount = port?.newCount?.() ?? stepCount;
  const [gapsOpen, setGapsOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [approxOpen, setApproxOpen] = useState(false);
  const gapsPopover = usePopoverDismissal(gapsOpen, setGapsOpen);
  const zoomPopover = usePopoverDismissal(zoomOpen, setZoomOpen);
  const approxPopover = usePopoverDismissal(approxOpen, setApproxOpen);
  const running = summary !== null && !terminal;
  // The fold keeps meta.state current; the summary is fetched once at open (lane review I-2).
  const state = session?.meta.state ?? summary?.state;
  const statusLine = statusText(status, loadedFraction, summary, state, terminal);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [running]);

  // Before the first event there is no prompt and no span to report (a window opened ahead of the task).
  const hasEvents = session !== null && session.steps.length > 0;
  const spanMs = session === null ? 0 : displaySpanMs(session);
  const durationMs = running ? Math.max(spanMs, nowT()) : spanMs;
  const newProblems =
    session === null
      ? 0
      : session.findings.filter((finding) => finding.severity === "critical" && finding.anchorSeq > lastSeenSeq).length;
  const gaps = session?.gaps ?? [];
  const gapsText = gaps.length === 1 ? "1 gap" : `${gaps.length} gaps`;
  const approximate = session?.coverage.approximateJoins ?? false;

  const jumpToSeq = (seq: number): void => {
    if (session === null) return;
    const step = session.steps[Math.max(0, index.stepIndexAtOrBefore(seq))];
    if (step !== undefined) dispatch({ type: "select", id: step.id, by: "shell" });
  };

  const goLive = (): void => {
    if (port?.goToTail?.() === true) return;
    dispatch({ type: "nav/last" });
    if (running) dispatch({ type: "follow/set", follow: true });
  };

  return (
    <div className={styles.bar} data-chrome={chrome}>
      {embedded ? (
        <>
          {showSwitch ? <ViewSwitch /> : null}
          <span className={styles.spacer} />
        </>
      ) : (
        <p className={styles.title} title={displayUntrusted(summary?.prompt ?? "")}>
          {summary === null ? null : (
            <>
              <span className={styles.repo}>{displayUntrusted(summary.repoName)}</span>
              <span className={styles.sep}> / </span>
              <span className={styles.prompt}>
                {summary.prompt.trim() === "" ? WAITING_FOR_PROMPT : displayUntrusted(firstLine(summary.prompt))}
              </span>
            </>
          )}
        </p>
      )}

      {approximate ? (
        <span className={styles.anchor} ref={approxPopover.anchorRef}>
          <button
            type="button"
            ref={approxPopover.triggerRef}
            className={styles.chip}
            data-tone="neutral"
            aria-expanded={approxOpen}
            aria-haspopup="dialog"
            onClick={() => setApproxOpen((open) => !open)}
          >
            ≈ Approximate joins
          </button>
          {approxOpen ? (
            <div role="dialog" aria-label="Approximate joins" className={styles.note}>
              Some chapters were joined to steps by time window, because this session was recorded before the
              exact step links existed. The window is an edit to one of the unit's files within 5 s of the unit's
              createdAt–updatedAt span, else that file's latest earlier edit. Their step lists can be slightly off.
            </div>
          ) : null}
        </span>
      ) : null}

      {gaps.length > 0 ? (
        <span className={styles.anchor} ref={gapsPopover.anchorRef}>
          <button
            type="button"
            ref={gapsPopover.triggerRef}
            className={embedded ? `${styles.chip} ${styles.chipCompact}` : styles.chip}
            data-tone="neutral"
            aria-expanded={gapsOpen}
            // Embedded (the main window, from 880 px): icon and count only, the full text as name and tooltip.
            aria-label={embedded ? gapsText : undefined}
            title={embedded ? gapsText : undefined}
            onClick={() => setGapsOpen((open) => !open)}
          >
            {embedded ? (
              <>
                <Icon name="eyeoff" size={12} />
                {gaps.length}
              </>
            ) : (
              gapsText
            )}
          </button>
          {gapsOpen ? (
            <ul className={styles.popover} aria-label="Gaps">
              {gaps.map((gap, position) => (
                <li key={`${gap.kind}:${gap.atSeq}:${position}`}>
                  <button
                    type="button"
                    className={styles.popoverItem}
                    onClick={() => {
                      jumpToSeq(gap.atSeq);
                      gapsPopover.close();
                    }}
                  >
                    {`seq ${gap.atSeq} · ${GAP_LABEL[gap.kind]}`}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </span>
      ) : null}

      {!embedded && showSwitch ? <ViewSwitch /> : null}

      <div role="group" aria-label="Follow" className={styles.segmented}>
        <button
          type="button"
          aria-pressed={!follow}
          className={styles.segment}
          onClick={() => dispatch({ type: "follow/set", follow: false })}
        >
          <Icon name="clock" size={14} />
          <span>Review</span>
        </button>
        <button
          type="button"
          aria-pressed={follow}
          className={styles.segment}
          disabled={!running}
          onClick={goLive}
        >
          <Icon name="live" size={14} />
          <span>{terminal && state !== undefined ? agentStateLabel(state) : "Live"}</span>
        </button>
      </div>

      {!follow && newCount > 0 ? (
        <button type="button" className={styles.newPill} onClick={goLive}>
          <span>{`${newCount} new`}</span>
          {newProblems > 0 ? (
            <span
              className={styles.badDot}
              role="img"
              aria-label="includes a critical finding"
              data-testid="new-critical-dot"
            />
          ) : null}
        </button>
      ) : null}

      <span className={styles.meta}>
        {hasEvents && !embedded ? <span className={styles.duration}>{formatDuration(durationMs)}</span> : null}
        {statusLine === "" || (embedded && status.kind === "ready" && loadedFraction >= 1) ? null : (
          <>
            {hasEvents && !embedded ? <span aria-hidden="true"> · </span> : null}
            <span>{statusLine}</span>
          </>
        )}
      </span>

      {status.kind === "error" ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      ) : null}

      {port === undefined || port.zoom.label() === "" ? null : (
        <span className={styles.anchor} ref={zoomPopover.anchorRef}>
          <button
            type="button"
            ref={zoomPopover.triggerRef}
            className={styles.zoom}
            aria-haspopup="true"
            aria-expanded={zoomOpen}
            onClick={() => setZoomOpen((open) => !open)}
          >
            <span>{port.zoom.label()}</span>
            <Icon name="chev-d" size={12} />
          </button>
          {zoomOpen ? (
            <div className={styles.menu}>
              {port.zoom.presets().map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={styles.popoverItem}
                  onClick={() => {
                    port.zoom.applyPreset(preset.id);
                    zoomPopover.close();
                  }}
                >
                  {preset.label}
                </button>
              ))}
              <button type="button" className={styles.popoverItem} onClick={() => port.zoom.zoomIn()}>
                Zoom in
              </button>
              <button type="button" className={styles.popoverItem} onClick={() => port.zoom.zoomOut()}>
                Zoom out
              </button>
              <button type="button" className={styles.popoverItem} onClick={() => port.zoom.fitAll()}>
                Fit all
              </button>
            </div>
          ) : null}
        </span>
      )}

      {/* Above the right panel (H1 mockup). With nothing selected the Brief already shows: pressed and disabled. */}
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={!hasSelection || briefPinned}
        disabled={!hasSelection}
        title="Brief (Shift+B)"
        onClick={() => dispatch({ type: "brief/toggle" })}
      >
        <Icon name="brief" size={14} />
        <span>Brief</span>
      </button>
    </div>
  );
}

/** Wraps itself in its own boundary (lane ruling): the Shell does not wrap regions. */
export function TitleBar(props: TitleBarProps) {
  return (
    <ErrorBoundary region="Title bar">
      <TitleBarBody {...props} />
    </ErrorBoundary>
  );
}
