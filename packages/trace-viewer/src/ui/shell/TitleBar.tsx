import { useContext, useEffect, useState } from "react";

import type { TraceSessionSummary } from "@jevcode/contracts";

import { agentStateLabel, displayUntrusted, formatDuration, type GapKind, type TraceSession } from "../../model/index.js";
import { Icon } from "../icons/Icon.js";
import { useDispatch, useView } from "../state/store.js";
import { selectNewCount } from "../state/view-state.js";
import { useActiveViewPort, ViewDefinitionsContext } from "../views/view-port.js";
import type { DataStatus } from "./data-controller.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { useSessionView } from "./session-context.js";
import styles from "./TitleBar.module.css";
import { usePopoverDismissal } from "./use-popover.js";

export interface TitleBarProps {
  onRetry(): void;
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

function firstLine(text: string): string {
  const end = text.search(/\r?\n/);
  return end < 0 ? text : text.slice(0, end);
}

function statusText(status: DataStatus, loadedFraction: number, summary: TraceSessionSummary | null): string {
  switch (status.kind) {
    case "loading":
      return summary === null ? "Loading" : `Loading ${Math.floor(loadedFraction * 100)}%`;
    case "reconnecting":
      return `Reconnecting (${status.attempt})`;
    case "error":
      return `${status.channel}: ${status.message}`;
    case "ready":
      if (loadedFraction < 1) return `Loading ${Math.floor(loadedFraction * 100)}%`;
      return summary === null ? "" : agentStateLabel(summary.state);
  }
}

function TitleBarBody({ onRetry }: TitleBarProps) {
  const { summary, session, index, status, loadedFraction, terminal, nowT } = useSessionView();
  const views = useContext(ViewDefinitionsContext);
  const dispatch = useDispatch();
  const view = useView((state) => state.view);
  const follow = useView((state) => state.follow);
  const lastSeenSeq = useView((state) => state.lastSeenSeq);
  const newCount = useView((state) => selectNewCount(state, index));
  const port = useActiveViewPort();
  const [gapsOpen, setGapsOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [approxOpen, setApproxOpen] = useState(false);
  const gapsPopover = usePopoverDismissal(gapsOpen, setGapsOpen);
  const zoomPopover = usePopoverDismissal(zoomOpen, setZoomOpen);
  const approxPopover = usePopoverDismissal(approxOpen, setApproxOpen);
  const running = summary !== null && !terminal;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [running]);

  const spanMs = session === null ? 0 : displaySpanMs(session);
  const durationMs = running ? Math.max(spanMs, nowT()) : spanMs;
  const newProblems =
    session === null
      ? 0
      : session.findings.filter((finding) => finding.severity === "critical" && finding.anchorSeq > lastSeenSeq).length;
  const gaps = session?.gaps ?? [];
  const approximate = session?.coverage.approximateJoins ?? false;

  const jumpToSeq = (seq: number): void => {
    if (session === null) return;
    const step = session.steps[Math.max(0, index.stepIndexAtOrBefore(seq))];
    if (step !== undefined) dispatch({ type: "select", id: step.id, by: "shell" });
  };

  const goLive = (): void => {
    dispatch({ type: "nav/last" });
    if (running) dispatch({ type: "follow/set", follow: true });
  };

  return (
    <div className={styles.bar}>
      <p className={styles.title} title={displayUntrusted(summary?.prompt ?? "")}>
        {summary === null ? null : (
          <>
            <span className={styles.repo}>{displayUntrusted(summary.repoName)}</span>
            <span className={styles.sep}> / </span>
            <span className={styles.prompt}>{displayUntrusted(firstLine(summary.prompt))}</span>
          </>
        )}
      </p>

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
              exact step links existed. Their step lists can be slightly off.
            </div>
          ) : null}
        </span>
      ) : null}

      {gaps.length > 0 ? (
        <span className={styles.anchor} ref={gapsPopover.anchorRef}>
          <button
            type="button"
            ref={gapsPopover.triggerRef}
            className={styles.chip}
            data-tone="neutral"
            aria-expanded={gapsOpen}
            onClick={() => setGapsOpen((open) => !open)}
          >
            {gaps.length === 1 ? "1 gap" : `${gaps.length} gaps`}
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

      {views.length > 1 ? (
        <div role="radiogroup" aria-label="View" className={styles.segmented}>
          {views.map((definition, position) => (
            <button
              key={definition.kind}
              type="button"
              role="radio"
              aria-checked={definition.kind === view}
              className={styles.segment}
              title={`${definition.label} (${position + 1})`}
              onClick={() => dispatch({ type: "view/switch", view: definition.kind })}
            >
              <Icon name={definition.icon} size={14} />
              <span>{definition.label}</span>
            </button>
          ))}
        </div>
      ) : null}

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
          <span>{terminal && summary !== null ? agentStateLabel(summary.state) : "Live"}</span>
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
        <span className={styles.duration}>{formatDuration(durationMs)}</span>
        <span aria-hidden="true"> · </span>
        <span>{statusText(status, loadedFraction, summary)}</span>
      </span>

      {status.kind === "error" ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      ) : null}

      {port === undefined ? null : (
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
