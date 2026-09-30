import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ComponentType } from "react";

import {
  buildSpineRows,
  estimateSpineRowSize,
  SPINE_ROW_PX,
  spineRowIndexForSeq,
  type SpineRow,
} from "../../../../layout/spine-rows.js";
import { brushSeqRange } from "../../../../layout/trace-index.js";
import {
  formatDuration,
  formatOffset,
  type Finding,
  type FindingId,
  type Step,
  type StepId,
  type TraceSession,
} from "../../../../model/index.js";
import { markAfterPaint, PERF } from "../../../shell/perf.js";
import { useDiagnostics, useSessionView } from "../../../shell/session-context.js";
import { useDispatch, useView, useViewStore } from "../../../state/store.js";
import { selectEffectivePlayheadSeq, selectNewCount } from "../../../state/view-state.js";
import { NewBadge } from "../../shared/NewBadge.js";
import { GroupRow } from "./rows/GroupRows.js";
import { SeparatorRow } from "./rows/SeparatorRows.js";
import { StepRow } from "./rows/StepRow.js";
import { rowFindingOf } from "../../../inspector/finding-copy.js";
import { endClampedTopRow, extendRange, firstRowAtOrAfter, pushTarget, revealAlign, spineVirtualOptions, type PushCandidate } from "./scroll-sync.js";
import styles from "./Spine.module.css";

export interface FindingBodyProps {
  finding: Finding;
  step: Step;
  session: TraceSession;
  onJump(stepId: StepId): void;
  /** "header" renders the signal's inline header extras (next to the row title), if it has any; default "body". */
  part?: "header" | "body";
}

export const FindingBodyContext = createContext<ComponentType<FindingBodyProps> | null>(null);

export interface SpineApi {
  rows(): readonly SpineRow[];
  revealSeq(seq: number, align: "auto" | "center"): void;
  focusRow(key: string): void;
}

export interface SpineProps {
  active: boolean;
  apiRef: { current: SpineApi | null };
  onWindow?(window: { t0: number; t1: number } | null): void;
  onAnchor?(anchor: { key: string; offsetPx: number } | null): void;
}

function virtualKey(row: SpineRow | undefined, position: number): string | number {
  if (row === undefined) return position;
  return row.t === "step" && row.expanded ? `${row.key}+x` : row.key;
}

function rowT(row: SpineRow | undefined, session: TraceSession): number | null {
  if (row === undefined) return null;
  switch (row.t) {
    case "step":
      return session.steps[row.step]?.tMs ?? null;
    case "chapter":
      return session.chapters[row.chapter]?.tMs ?? null;
    case "noise":
    case "elided":
      return session.steps[row.steps[0] ?? -1]?.tMs ?? null;
    case "turn":
      return session.turns[row.turn]?.tMs ?? null;
    default:
      return null;
  }
}

function rowSeq(row: SpineRow | undefined, session: TraceSession): number | null {
  if (row === undefined) return null;
  switch (row.t) {
    case "step":
      return session.steps[row.step]?.firstSeq ?? null;
    case "chapter": {
      const chapter = session.chapters[row.chapter];
      const first = chapter?.stepIds[0];
      return session.steps.find((step) => step.id === first)?.firstSeq ?? chapter?.firstSeq ?? null;
    }
    case "noise":
    case "elided":
      return session.steps[row.steps[0] ?? -1]?.firstSeq ?? null;
    default:
      return null;
  }
}

/** Row that a selection id names: a step row by key, a chapter row by its unit id. */
function rowHoldsSelection(row: SpineRow, session: TraceSession, selection: string | null): boolean {
  if (selection === null) return false;
  if (row.t === "step") return row.key === selection;
  if (row.t === "chapter") return session.chapters[row.chapter]?.id === selection;
  return false;
}

/** Wheel, touch, scrollbar and key input mark the next scroll frames as the reader's own. */
const USER_INPUT_EVENTS = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;
/** A scroll counts as the reader's for this long after the last input or scroll frame. */
const USER_SCROLL_MS = 400;
/** A programmatic scroll that never reports "done" stops suppressing pushes after this long. */
const SUPPRESS_MS = 500;

/** DOM id of a row's headline element; the article is labelled by it (spec feed rule). */
function lineIdOf(key: string): string {
  return `spine-line:${key}`;
}

export function Spine({ active, apiRef, onWindow, onAnchor }: SpineProps) {
  const { session, index, scale, terminal, loadedFraction, nowT } = useSessionView();
  const store = useViewStore();
  const dispatch = useDispatch();
  const diagnostics = useDiagnostics();
  const FindingBody = useContext(FindingBodyContext);
  const brush = useView((state) => state.brush);
  const level = useView((state) => state.level);
  const selection = useView((state) => state.selection);
  const expanded = useView((state) => state.expanded);
  const collapsed = useView((state) => state.collapsed);
  const search = useView((state) => state.search);
  const follow = useView((state) => state.follow);
  const focusRev = useView((state) => state.focusRev);
  const origin = useView((state) => state.playheadOrigin);
  const lastSeenSeq = useView((state) => state.lastSeenSeq);
  const playheadSeq = useView((state) => selectEffectivePlayheadSeq(state, index));
  const newCount = useView((state) => selectNewCount(state, index));
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const matches = useMemo(() => (search === null ? undefined : new Set<string>(search.matchIds)), [search]);
  const rows = useMemo<SpineRow[]>(
    () =>
      session === null
        ? []
        : buildSpineRows(session, index, scale, {
            brush,
            level,
            playheadSeq,
            selection,
            expanded,
            collapsed,
            matches,
            live: !terminal,
          }),
    [session, index, scale, brush, level, playheadSeq, selection, expanded, collapsed, matches, terminal],
  );
  const findingsById = useMemo(
    () => new Map<FindingId, Finding>((session?.findings ?? []).map((finding) => [finding.id, finding])),
    [session],
  );
  const playheadIndex = useMemo(
    () => (session === null ? -1 : spineRowIndexForSeq(rows, session, playheadSeq)),
    [rows, session, playheadSeq],
  );
  const selectionIndex = useMemo(
    () => (session === null ? -1 : rows.findIndex((row) => rowHoldsSelection(row, session, selection))),
    [rows, session, selection],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const focusKey = useRef<string | null>(null);
  /** Set by a user action (focusRow); consumed once, so a data rebuild never moves focus. */
  const pendingFocus = useRef<string | null>(null);
  const focusIndex = focusKey.current === null ? -1 : rows.findIndex((row) => row.key === focusKey.current);
  const mounted = useRef<number[]>([]);
  mounted.current = [playheadIndex, selectionIndex, focusIndex];

  const suppressPush = useRef(false);
  const suppressTimer = useRef<number | null>(null);
  const userScroll = useRef(false);
  const userTimer = useRef<number | null>(null);
  /** Reader input arrived since the last drift sample (lane review I-3); consumed by the sampler. */
  const readerMovedSinceSample = useRef(false);
  /** focusRev of the selection the spine itself wrote; consumed by the reveal effect. */
  const ownRev = useRef(-1);
  const frame = useRef<number | null>(null);
  const anchor = useRef<{ key: string; top: number; scroll: number } | null>(null);
  const reported = useRef<{ window: string; anchor: string }>({ window: "", anchor: "" });
  const handlers = useRef({ onWindow, onAnchor });
  handlers.current = { onWindow, onAnchor };

  const viewOf = (): (Window & typeof globalThis) | null => scrollRef.current?.ownerDocument.defaultView ?? null;

  const clearTimer = (timer: { current: number | null }): void => {
    if (timer.current === null) return;
    viewOf()?.clearTimeout(timer.current);
    timer.current = null;
  };

  /** A programmatic scroll (reveal, restore) is under way: pushes pause until it settles. */
  const beginProgrammatic = (): void => {
    suppressPush.current = true;
    clearTimer(suppressTimer);
    suppressTimer.current = viewOf()?.setTimeout(() => {
      suppressTimer.current = null;
      suppressPush.current = false;
    }, SUPPRESS_MS) ?? null;
  };
  const endProgrammatic = (): void => {
    suppressPush.current = false;
    clearTimer(suppressTimer);
  };
  /** The reader is scrolling: the reader wins over any programmatic scroll still settling. */
  const markUserScroll = (): void => {
    endProgrammatic();
    userScroll.current = true;
    readerMovedSinceSample.current = true;
    intendedOffset.current = null;
    clearTimer(userTimer);
    userTimer.current = viewOf()?.setTimeout(() => {
      userTimer.current = null;
      userScroll.current = false;
    }, USER_SCROLL_MS) ?? null;
  };

  /**
   * The offset the spine's own last reveal scrolled to, until the frame after it: the virtualizer learns the new
   * offset only from the scroll event, so a second reveal in the same commit would otherwise decide from the old one.
   */
  const intendedOffset = useRef<number | null>(null);
  /**
   * The viewport in list coordinates, from the virtualizer's own scroll offset and height. Reading element.scrollTop
   * here would force a synchronous layout right after React mutated the DOM (perf investigation fix 6).
   */
  const windowOf = (element: HTMLElement): { offset: number; height: number } => ({
    offset: intendedOffset.current ?? virtualizer.scrollOffset ?? element.scrollTop,
    height: virtualizer.scrollRect?.height || element.clientHeight,
  });

  const frameHandler = useRef<(scrolling: boolean) => void>(() => undefined);
  const scheduleFrame = (scrolling: boolean): void => {
    const view = viewOf();
    if (view === null || frame.current !== null) return;
    frame.current = view.requestAnimationFrame(() => {
      frame.current = null;
      frameHandler.current(scrolling);
    });
  };

  /** The end-clamped offset last start-aligned by the frame handler, so one clamp gets one correction. */
  const endSnapAt = useRef<number | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (position) => {
      const row = rowsRef.current[position];
      return row === undefined || session === null ? SPINE_ROW_PX : estimateSpineRowSize(row, session);
    },
    getItemKey: (position) => virtualKey(rowsRef.current[position], position),
    rangeExtractor: (range) => extendRange(defaultRangeExtractor(range), mounted.current, range.count),
    onChange: (instance) => scheduleFrame(instance.isScrolling),
    ...spineVirtualOptions(follow),
  });

  frameHandler.current = (scrolling: boolean): void => {
    const element = scrollRef.current;
    if (element === null || session === null) return;
    const win = windowOf(element);
    const items = virtualizer.getVirtualItems();
    const visible = items.filter((item) => item.end > win.offset && item.start < win.offset + win.height);
    const first = visible[0];
    const last = visible[visible.length - 1];
    const t0 = rowT(rowsRef.current[first?.index ?? -1], session);
    const t1 = rowT(rowsRef.current[last?.index ?? -1], session);
    const windowValue = t0 === null || t1 === null ? null : { t0, t1 };
    const windowKey = windowValue === null ? "" : `${windowValue.t0}|${windowValue.t1}`;
    if (windowKey !== reported.current.window) {
      reported.current.window = windowKey;
      handlers.current.onWindow?.(windowValue);
    }
    const firstRow = rowsRef.current[first?.index ?? -1];
    if (first !== undefined && firstRow !== undefined) {
      const offsetPx = first.start - win.offset;
      anchor.current = { key: firstRow.key, top: offsetPx, scroll: win.offset };
      const anchorKey = `${firstRow.key}|${offsetPx}`;
      if (anchorKey !== reported.current.anchor) {
        reported.current.anchor = anchorKey;
        handlers.current.onAnchor?.({ key: firstRow.key, offsetPx });
      }
    }
    if (!scrolling) {
      const readerScrolled = userScroll.current;
      endProgrammatic();
      userScroll.current = false;
      clearTimer(userTimer);
      // A finished session opens scrolled to the list end, and rows measured after the reveal (the expanded claim)
      // can leave the end clamp cutting the top row under the range chip. Start-align that row once, unless the reader
      // put the list there; the playhead row must stay whole (audit 2-8, integration item 5).
      if (terminal && !readerScrolled && endSnapAt.current !== win.offset) {
        const playItem = items.find((item) => item.index === playheadIndex);
        const keep = playItem ?? first;
        const cut = keep === undefined ? null : endClampedTopRow(items, win, Math.max(0, virtualizer.getTotalSize() - win.height), keep);
        if (cut !== null) {
          endSnapAt.current = win.offset;
          beginProgrammatic();
          virtualizer.scrollToIndex(cut, { align: "start", behavior: "auto" });
        }
      }
      return;
    }
    // Only the reader's own scroll moves the playhead; reveals, restores, anchoring and follow never do.
    if (suppressPush.current || !userScroll.current) return;
    markUserScroll();
    const playItem = items.find((item) => item.index === playheadIndex);
    const candidates: PushCandidate[] = visible.map((item) => ({
      index: item.index,
      start: item.start,
      end: item.end,
      target: rowSeq(rowsRef.current[item.index], session) !== null,
    }));
    const target = pushTarget(playItem === undefined ? null : { start: playItem.start, end: playItem.end }, candidates, win);
    const seq = target === null ? null : rowSeq(rowsRef.current[target], session);
    if (seq !== null) dispatch({ type: "playhead/set", playhead: { kind: "free", seq }, origin: "spine" });
  };

  // Reader input marks the scroll as the reader's own (the scroll event alone cannot tell it from anchoring).
  useEffect(() => {
    const element = scrollRef.current;
    if (!active || element === null) return undefined;
    const listeners = USER_INPUT_EVENTS.map((name) => {
      const listener = (): void => markUserScroll();
      element.addEventListener(name, listener, { passive: true });
      return [name, listener] as const;
    });
    return () => {
      for (const [name, listener] of listeners) element.removeEventListener(name, listener);
    };
  }, [active, session === null]);

  // A quiet Live agent still ages: the footer and running bars advance once a second without new data.
  useEffect(() => {
    const view = viewOf();
    if (view === null || terminal || !active) return undefined;
    const handle = view.setInterval(rerender, 1_000);
    return () => view.clearInterval(handle);
  }, [terminal, active, session === null]);

  useEffect(
    () => () => {
      const view = viewOf();
      if (view !== null && frame.current !== null) view.cancelAnimationFrame(frame.current);
      frame.current = null;
      clearTimer(suppressTimer);
      clearTimer(userTimer);
    },
    [],
  );

  /** Rows revealed in this commit's layout effects; a queued revealSeq for the same row then adds no second scroll. */
  const revealedThisCommit = useRef<number[]>([]);
  const revealIndex = (position: number, align: "auto" | "center"): void => {
    const element = scrollRef.current;
    // Rows measured in this commit (an expanded finding row mounting) reach measurementsCache only through
    // getMeasurements(); getTotalSize() runs it, so the offsets and the list end below are the measured ones.
    const totalSize = virtualizer.getTotalSize();
    const cache = virtualizer.measurementsCache;
    const item = cache[position];
    if (element === null || item === undefined) return;
    revealedThisCommit.current.push(position);
    const win = windowOf(element);
    const decided = align === "center" ? "center" : revealAlign({ start: item.start, end: item.end }, win);
    if (decided === "none") return;
    const target = virtualizer.getOffsetForIndex(position, decided);
    if (target === undefined) return;
    // Start-align the row at or after the wanted offset, so the reveal lands on a row start (audit 2-8). Scrolling by
    // index keeps the virtualizer re-targeting while expanded rows are measured.
    const maxOffset = Math.max(0, totalSize - win.height);
    let snapped = firstRowAtOrAfter(target[0], cache.length, (i) => cache[i]?.start ?? 0);
    // Near the end of the list the browser clamps the offset; start-align the row before instead, so the top row
    // stays whole and the cut, if any, falls at the bottom edge.
    if (snapped > 0 && (cache[snapped]?.start ?? 0) > maxOffset) snapped -= 1;
    const start = cache[snapped]?.start;
    beginProgrammatic();
    if (snapped < 0 || start === undefined) virtualizer.scrollToIndex(position, { align: decided, behavior: "auto" });
    else virtualizer.scrollToIndex(snapped, { align: "start", behavior: "auto" });
    intendedOffset.current = Math.max(0, Math.min(start ?? target[0], maxOffset));
    const view = viewOf();
    // The scroll event (which updates the virtualizer) runs before the next frame's callbacks.
    view?.requestAnimationFrame(() => {
      intendedOffset.current = null;
    });
  };

  // An external playhead write (overview, keys, search, finding, outline) reveals the playhead row.
  // The spine's own writes and clicks never scroll; a data rebuild that changes none of the inputs does nothing.
  const lastReveal = useRef<{ seq: number; rev: number; origin: string } | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const previous = lastReveal.current;
    lastReveal.current = { seq: playheadSeq, rev: focusRev, origin };
    if (previous !== null && previous.seq === playheadSeq && previous.rev === focusRev && previous.origin === origin) return;
    const ownClick = previous !== null && previous.rev !== focusRev && focusRev === ownRev.current;
    if (playheadIndex < 0 || origin === "spine" || ownClick) return;
    revealIndex(playheadIndex, "auto");
  }, [playheadSeq, focusRev, origin, active, playheadIndex]);

  // A reveal asked through the api (the view port, e.g. after j) waits for this render: it names a seq, and resolving it
  // against the previous render's rows could pick a stale row and scroll twice (perf fix 6). When the playhead effect
  // above already revealed the same row in this commit, the queued reveal is dropped.
  const pendingReveal = useRef<{ seq: number; align: "auto" | "center" } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingReveal.current;
    if (pending === null || session === null) return;
    pendingReveal.current = null;
    if (!active) return;
    const position = spineRowIndexForSeq(rowsRef.current, session, pending.seq);
    if (position >= 0 && !revealedThisCommit.current.includes(position)) revealIndex(position, pending.align);
  });
  // The record covers one commit's layout effects only.
  useEffect(() => {
    revealedThisCommit.current = [];
  });

  // A brush or level change replaces the row set: reveal the playhead row centered.
  const setKey = `${level}|${brush.kind}|${brush.kind === "chapter" ? brush.anchorSeq : brush.kind === "range" ? `${brush.fromSeq}-${brush.toSeq}` : ""}`;
  const lastSetKey = useRef(setKey);
  useLayoutEffect(() => {
    if (lastSetKey.current === setKey) return;
    lastSetKey.current = setKey;
    if (active && playheadIndex >= 0) revealIndex(playheadIndex, "center");
  }, [setKey, active, playheadIndex]);

  // Restore the saved spine anchor when the view is shown again in sync (spec §7.8 item 4).
  useLayoutEffect(() => {
    if (!active) return;
    const state = store.get();
    const saved = state.cameras.hybrid;
    if (saved?.spineAnchor == null || saved.syncedRev !== state.focusRev) return;
    const position = rowsRef.current.findIndex((row) => row.key === saved.spineAnchor?.key);
    const item = virtualizer.measurementsCache[position];
    if (item === undefined) return;
    beginProgrammatic();
    virtualizer.scrollToOffset(Math.max(0, item.start - saved.spineAnchor.offsetPx), { behavior: "auto" });
  }, [active]);

  // Selftest: anchored-row drift after each applied row set (spec §10 "Anchor drift").
  useLayoutEffect(() => {
    if (!diagnostics.enabled) return undefined;
    const before = anchor.current;
    const element = scrollRef.current;
    const view = viewOf();
    if (before === null || element === null || view === null) return undefined;
    const id = view.requestAnimationFrame(() => {
      const node = Array.from(element.querySelectorAll<HTMLElement>("[data-key]")).find((item) => item.dataset.key === before.key);
      if (node === undefined) return;
      const top = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
      // Any movement of the anchored row is drift, including a scroll the viewer made (a stray follow, a reveal after
      // an append, a wrong anchor compensation). Only the reader's own input since the last sample re-baselines it.
      if (readerMovedSinceSample.current) readerMovedSinceSample.current = false;
      else diagnostics.reportDrift(Math.abs(top - before.top));
      anchor.current = { key: before.key, top, scroll: element.scrollTop };
    });
    return () => view.cancelAnimationFrame(id);
  }, [rows, diagnostics]);

  // Refresh the published window and anchor after every applied row set.
  useEffect(() => {
    scheduleFrame(false);
  }, [rows]);

  const painted = useRef(false);
  useEffect(() => {
    if (painted.current || rows.length === 0) return;
    painted.current = true;
    markAfterPaint(PERF.firstPaint, PERF.bundleParsed);
  }, [rows.length]);

  const findNode = (key: string): HTMLElement | undefined =>
    Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("article[data-key]") ?? []).find((item) => item.dataset.key === key);

  // Consumes a pending focus request once its row is mounted (focusRow keeps the row mounted meanwhile).
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    if (!rowsRef.current.some((row) => row.key === key)) {
      pendingFocus.current = null;
      return;
    }
    const node = findNode(key);
    if (node === undefined) return;
    pendingFocus.current = null;
    node.focus({ preventScroll: true });
  });

  useLayoutEffect(() => {
    apiRef.current = {
      rows: () => rowsRef.current,
      revealSeq: (seq, align) => {
        if (session === null) return;
        pendingReveal.current = { seq, align };
        rerender();
      },
      focusRow: (key) => {
        const position = rowsRef.current.findIndex((row) => row.key === key);
        if (position < 0) return;
        focusKey.current = key;
        pendingFocus.current = key;
        const node = findNode(key);
        if (node !== undefined) {
          pendingFocus.current = null;
          node.focus({ preventScroll: true });
        }
        revealIndex(position, "auto");
        if (node === undefined) rerender();
      },
    };
    return () => {
      apiRef.current = null;
    };
  });

  const selectRow = (id: string): void => {
    dispatch({ type: "select", id: id as StepId, by: "hybrid" });
    ownRev.current = store.get().focusRev;
  };

  const toggleFinding = (step: Step, isExpanded: boolean): void => {
    if (session === null) return;
    const finding = rowFindingOf(session, step, findingsById)?.finding ?? null;
    if (isExpanded) {
      dispatch({ type: "expand/set", key: step.id, expanded: false });
      if (finding !== null) dispatch({ type: "expand/set", key: finding.id, expanded: false });
    } else {
      dispatch({ type: "expand/set", key: step.id, expanded: true });
    }
  };

  const jump = (stepId: StepId): void => {
    const step = session?.steps.find((item) => item.id === stepId);
    if (step !== undefined) dispatch({ type: "playhead/set", playhead: { kind: "free", seq: step.firstSeq }, origin: "finding" });
  };

  if (session === null) {
    return (
      <div className={styles.spine}>
        <div aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <div key={n} className={styles.placeholder} />
          ))}
        </div>
      </div>
    );
  }

  const range = brushSeqRange(brush, index);
  const rangeFrom = session.steps[Math.max(0, index.stepIndexAtOrAfter(range.fromSeq))]?.tMs ?? 0;
  const rangeTo = session.steps[Math.max(0, index.stepIndexAtOrBefore(range.toSeq))]?.tMs ?? rangeFrom;
  const hourGutter = (session.steps.at(-1)?.tMs ?? 0) >= 3_600_000;
  // Roving tab stop: the row that holds focus, else the selected row, else the playhead row.
  const tabKey =
    (focusIndex >= 0 ? rows[focusIndex]?.key : undefined) ??
    rows[selectionIndex]?.key ??
    rows[playheadIndex]?.key ??
    rows[0]?.key ??
    null;
  const nowMs = session.originMs + nowT();
  const newProblems = session.findings.filter((finding) => finding.severity === "critical" && finding.anchorSeq > lastSeenSeq).length;
  const afterRange = brush.kind !== "session" && !(brush.kind === "range" && brush.toSeq === "live");
  const lastEventT = session.steps.at(-1)?.tMs ?? 0;

  let empty: string | null = null;
  if (rows.length === 0) {
    if (session.steps.length === 0 && session.loadedThroughSeq === 0) empty = "Waiting for the agent's first event";
    else if (session.steps.length === 0) empty = `${session.loadedThroughSeq.toLocaleString("en-US")} events, none describe agent work`;
    else empty = `Nothing between ${formatOffset(rangeFrom)} and ${formatOffset(rangeTo)}`;
  }

  return (
    <div className={styles.spine}>
      <div className={styles.chip}>
        <span className={styles.chipBar} aria-hidden="true" />
        <span>{`${formatOffset(rangeFrom)} – ${formatOffset(rangeTo)}`}</span>
      </div>
      <div className={styles.chipFade} aria-hidden="true" />
      {empty === null ? null : <p className={styles.empty}>{empty}</p>}
      <div
        ref={scrollRef}
        className={styles.scroll}
        data-scroll-root=""
        role="feed"
        aria-label="Reading spine"
        aria-busy={loadedFraction < 1}
      >
        <div className={styles.sizer} data-hour={hourGutter ? "" : undefined} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            const measured = row.t === "step" && row.expanded;
            const isPlayhead = item.index === playheadIndex;
            const isSelected = item.index === selectionIndex;
            return (
              <article
                key={row.key}
                ref={measured ? virtualizer.measureElement : undefined}
                data-index={item.index}
                data-key={row.key}
                data-playhead={isPlayhead ? "" : undefined}
                aria-posinset={item.index + 1}
                aria-setsize={rows.length}
                aria-labelledby={lineIdOf(row.key)}
                tabIndex={row.key === tabKey ? 0 : -1}
                className={styles.slot}
                style={{ transform: `translateY(${item.start}px)`, height: measured ? undefined : item.size }}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) focusKey.current = row.key;
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (focusKey.current === row.key && next !== null && !event.currentTarget.contains(next)) {
                    focusKey.current = null;
                  }
                }}
              >
                {row.t === "step" ? (
                  (() => {
                    const step = session.steps[row.step];
                    if (step === undefined) return null;
                    return (
                      <StepRow
                        step={step}
                        session={session}
                        index={index}
                        findingsById={findingsById}
                        expanded={row.expanded}
                        selected={step.id === selection}
                        playhead={isPlayhead}
                        matched={matches?.has(step.id) ?? false}
                        hourGutter={hourGutter}
                        nowMs={nowMs}
                        FindingBody={FindingBody}
                        onSelect={() => selectRow(step.id)}
                        onToggle={() => toggleFinding(step, row.expanded)}
                        onJump={jump}
                        lineId={lineIdOf(row.key)}
                      />
                    );
                  })()
                ) : row.t === "turn" || row.t === "idle" || row.t === "gap" ? (
                  <SeparatorRow row={row} session={session} lineId={lineIdOf(row.key)} />
                ) : (
                  <GroupRow
                    row={row}
                    session={session}
                    selected={isSelected}
                    playhead={isPlayhead}
                    lineId={lineIdOf(row.key)}
                    onActivate={() => {
                      if (row.t === "chapter") {
                        const chapter = session.chapters[row.chapter];
                        if (chapter !== undefined) selectRow(chapter.id);
                      } else {
                        dispatch({ type: "expand/toggle", key: row.key });
                      }
                    }}
                  />
                )}
              </article>
            );
          })}
        </div>
      </div>
      <div className={styles.badge}>
        {follow ? null : (
          <NewBadge
            count={newCount}
            problems={newProblems}
            afterRange={afterRange}
            onActivate={() => {
              dispatch({ type: "nav/last" });
              if (!terminal) dispatch({ type: "follow/set", follow: true });
            }}
          />
        )}
      </div>
      {terminal ? null : (
        <p className={styles.footer}>{`Agent running · last event ${formatDuration(Math.max(0, nowT() - lastEventT))} ago`}</p>
      )}
    </div>
  );
}
