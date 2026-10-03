import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";

import type { TraceRow } from "@jevcode/contracts";

import { buildConsoleRows, consoleNewRowCount, consoleRowStepIds, type ConsoleRow, type ConsoleRowsState } from "../../../layout/console-rows.js";
import { ROWS_RELEASED_MARK } from "../../../source.js";
import type { SelectionId, TraceIndex } from "../../../layout/trace-index.js";
import { buildSearchIndex, type SearchIndex, type TraceSession } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import { useViewerHost } from "../../shell/host-context.js";
import { useDecisionAnswers } from "../../shell/decision-answers.js";
import { measureFromFirstAfterPaint, PERF } from "../../shell/perf.js";
import { searchMatches } from "../../shell/Outline/outline-rows.js";
import { useDiagnostics, useSessionView } from "../../shell/session-context.js";
import { useDispatch, useView, useViewStore } from "../../state/store.js";
import { extendRange, revealAlign, spineVirtualOptions } from "../hybrid/spine/scroll-sync.js";
import { NewBadge } from "../shared/NewBadge.js";
import { useRegisterViewPort, ViewPortRegistryContext, type ViewPort, type ViewProps, type ZoomPort } from "../view-port.js";
import { ConsoleRowView, estimateConsoleRow, expandKey, isExpandable, isRunningRow } from "./ConsoleRowView.js";
import styles from "./ConsoleView.module.css";
import { storySentenceIds } from "../../explainer/StoryBlock.js";

const EMPTY_ROWS: ConsoleRowsState = { rows: [], byStep: new Map() };
/** Wheel, touch, pointer and key input mark the next scroll frames as the reader's own. */
const USER_INPUT_EVENTS = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;
const USER_SCROLL_MS = 400;
/** Within this many px of the end the reader is "at the bottom" (the spine's scrollEndThreshold). */
const END_THRESHOLD_PX = 24;
/** The approved mockup's log padding (console-main.html `.log`). */
const LOG_PADDING_TOP_PX = 4;
const LOG_PADDING_BOTTOM_PX = 24;

/** The Console has no zoom; the title bar hides its zoom control for an empty label (deviation 15). */
const NO_ZOOM: ZoomPort = {
  label: () => "",
  presets: () => [],
  applyPreset: () => undefined,
  zoomIn: () => undefined,
  zoomOut: () => undefined,
  resetToPreset: () => undefined,
  fitAll: () => undefined,
  fitSelection: () => undefined,
};

/** The row that shows `selection`: a step's row, or the first shown step of a selected chapter. */
export function rowIndexOfSelection(
  state: ConsoleRowsState,
  session: TraceSession | null,
  index: TraceIndex,
  selection: SelectionId | null,
): number {
  if (selection === null || session === null) return -1;
  const direct = state.byStep.get(selection);
  if (direct !== undefined) return direct;
  const entry = index.entry(selection);
  if (entry?.kind !== "chapter") return -1;
  for (const stepId of session.chapters[entry.position]?.stepIds ?? []) {
    const at = state.byStep.get(stepId);
    if (at !== undefined) return at;
  }
  return -1;
}

/**
 * j/k order: one entry per row that shows a step (a read group stands for its first read); flag lines are skipped, since
 * their step has a row of its own. A folded Jev review row stands for its first guardrail step, which has no other row,
 * so the keyboard reaches it and Enter expands it (E M-3).
 */
export function consoleReadingOrder(rows: readonly ConsoleRow[]): SelectionId[] {
  const order: SelectionId[] = [];
  for (const row of rows) {
    if (row.kind === "finding" || row.kind === "summary") continue;
    const first = consoleRowStepIds(row)[0];
    if (first !== undefined) order.push(first as SelectionId);
  }
  return order;
}

/** A form control that lost focus by being disabled (focus fixup) left it without the reader's doing. */
function isDisabled(element: Element): boolean {
  return element.matches(":disabled");
}

function rowMatches(row: ConsoleRow, matches: ReadonlySet<string>): boolean {
  return matches.size > 0 && consoleRowStepIds(row).some((id) => matches.has(id));
}

/** Spec §3.2: the session as a terminal-style log, oldest at the top, following the tail while the reader is there. */
export function ConsoleView({ active }: ViewProps) {
  const { session, index, terminal, loadedFraction, nowT, payloads } = useSessionView();
  const store = useViewStore();
  const dispatch = useDispatch();
  const host = useViewerHost();
  const diagnostics = useDiagnostics();
  const follow = useView((state) => state.follow);
  const selection = useView((state) => state.selection);
  const expanded = useView((state) => state.expanded);
  const search = useView((state) => state.search);
  const focusBy = useView((state) => state.focusBy);
  const revealRev = useView((state) => state.revealRev);
  const lastSeenSeq = useView((state) => state.lastSeenSeq);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const previous = useRef<ConsoleRowsState | undefined>(undefined);
  const built = useMemo(
    () => (session === null ? EMPTY_ROWS : buildConsoleRows(session, index, previous.current)),
    [session, index],
  );
  previous.current = built;
  const rows = built.rows;
  const builtRef = useRef(built);
  builtRef.current = built;
  const live = useRef({ session, index, terminal });
  live.current = { session, index, terminal };
  const payloadsRef = useRef(payloads);
  payloadsRef.current = payloads;
  const fetchPayloads = useCallback((seqs: readonly number[]): Promise<TraceRow[]> => payloadsRef.current(seqs), []);

  const matches = useMemo(() => new Set<string>(search?.matchIds ?? []), [search]);
  // The pill counts new Console rows, not model steps (silent Jev steps make no row; reads are grouped).
  const newCount = consoleNewRowCount(built, index, lastSeenSeq);
  const selectedIndex = rowIndexOfSelection(built, session, index, selection);

  const scrollRef = useRef<HTMLDivElement>(null);
  const focusKey = useRef<string | null>(null);
  /** Set by a focus request (port.focusSelected); consumed once its row is mounted, so a rebuild never moves focus. */
  const pendingFocus = useRef<string | null>(null);
  /** The element inside a row that last took focus, with its row's key; the focus repair below reads it (E M-2). */
  const lastFocus = useRef<{ key: string; element: Element } | null>(null);
  const focusIndex = focusKey.current === null ? -1 : rows.findIndex((row) => row.key === focusKey.current);
  const mounted = useRef<number[]>([]);
  mounted.current = [selectedIndex, focusIndex];

  const userScroll = useRef(false);
  const userTimer = useRef<number | null>(null);
  /** Reader input arrived since the last drift sample; consumed by the sampler. */
  const readerMoved = useRef(false);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const frame = useRef<number | null>(null);
  const frameHandler = useRef<() => void>(() => undefined);
  const viewOf = (): (Window & typeof globalThis) | null => scrollRef.current?.ownerDocument.defaultView ?? null;
  const scheduleFrame = (): void => {
    const view = viewOf();
    if (view === null || frame.current !== null) return;
    frame.current = view.requestAnimationFrame(() => {
      frame.current = null;
      frameHandler.current();
    });
  };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (position) => estimateConsoleRow(builtRef.current.rows[position], store.get().expanded),
    getItemKey: (position) => builtRef.current.rows[position]?.key ?? position,
    rangeExtractor: (range) => extendRange(defaultRangeExtractor(range), mounted.current, range.count),
    onChange: () => scheduleFrame(),
    paddingStart: LOG_PADDING_TOP_PX,
    paddingEnd: LOG_PADDING_BOTTOM_PX,
    ...spineVirtualOptions(follow && active),
    // Row measurements run in the next frame, not inside the ResizeObserver delivery. Measured inside it, a size change
    // while following re-lays out the rows in the same delivery, and Chromium reports "ResizeObserver loop completed
    // with undelivered notifications" as a console error (the Electron main-window smoke, lane 03 D-6).
    useAnimationFrameWithResizeObserver: true,
  });

  // Coalesced per frame: remember the top row (drift), and let the reader's own scroll turn Live off and on.
  frameHandler.current = (): void => {
    const element = scrollRef.current;
    const current = live.current.session;
    if (element === null || current === null) return;
    const offset = virtualizer.scrollOffset ?? element.scrollTop;
    const height = virtualizer.scrollRect?.height || element.clientHeight;
    // The drift anchor is a layout read (getBoundingClientRect) on every scroll frame; only the selftest's drift sampler
    // uses it, so production frames skip it (lane triage t1, docs/perf.md "Console").
    const first = diagnostics.enabled ? virtualizer.getVirtualItems().find((item) => item.end > offset) : undefined;
    const firstRow = first === undefined ? undefined : builtRef.current.rows[first.index];
    if (first !== undefined && firstRow !== undefined) {
      // The anchor's top is read from the DOM, the same quantity the drift sampler compares after the next commit; the
      // virtualizer's model value can lag the DOM under load and read as drift.
      const node = findNode(firstRow.key);
      const top =
        node === undefined ? first.start - offset : node.getBoundingClientRect().top - element.getBoundingClientRect().top;
      anchor.current = { key: firstRow.key, top };
    }
    const atEnd = offset + height >= virtualizer.getTotalSize() - END_THRESHOLD_PX;
    const state = store.get();
    if (atEnd) {
      if (userScroll.current && !live.current.terminal && !state.follow) dispatch({ type: "follow/set", follow: true });
      else if (current.loadedThroughSeq > state.lastSeenSeq) dispatch({ type: "seen", seq: current.loadedThroughSeq });
    } else if (userScroll.current && state.follow) {
      dispatch({ type: "follow/set", follow: false });
    }
  };

  useEffect(() => {
    const element = scrollRef.current;
    const view = viewOf();
    if (!active || element === null || view === null) return undefined;
    const mark = (): void => {
      userScroll.current = true;
      readerMoved.current = true;
      if (userTimer.current !== null) view.clearTimeout(userTimer.current);
      userTimer.current = view.setTimeout(() => {
        userTimer.current = null;
        userScroll.current = false;
      }, USER_SCROLL_MS);
    };
    for (const name of USER_INPUT_EVENTS) element.addEventListener(name, mark, { passive: true });
    return () => {
      for (const name of USER_INPUT_EVENTS) element.removeEventListener(name, mark);
    };
  }, [active, session === null]);

  // A quiet Live agent still ages: running bars advance once a second without new data.
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
      if (view !== null && userTimer.current !== null) view.clearTimeout(userTimer.current);
      frame.current = null;
      userTimer.current = null;
    },
    [],
  );

  /** Going to the tail is now the reader's intent: a scroll from their last wheel must not turn Live off again. */
  const endReaderScroll = (): void => {
    userScroll.current = false;
    if (userTimer.current !== null) viewOf()?.clearTimeout(userTimer.current);
    userTimer.current = null;
  };

  /** The row revealed since the last frame: the port (after j/k) and the selection effect ask for the same row once. */
  const revealedThisFrame = useRef<number | null>(null);
  const reveal = (position: number): void => {
    const element = scrollRef.current;
    const view = viewOf();
    if (element === null || view === null || revealedThisFrame.current === position) return;
    virtualizer.getTotalSize(); // refreshes measurementsCache for rows added in this commit
    const item = virtualizer.measurementsCache[position];
    if (item === undefined) return;
    const win = { offset: virtualizer.scrollOffset ?? element.scrollTop, height: virtualizer.scrollRect?.height || element.clientHeight };
    const align = revealAlign({ start: item.start, end: item.end }, win);
    if (align === "none") return;
    revealedThisFrame.current = position;
    view.requestAnimationFrame(() => {
      revealedThisFrame.current = null;
    });
    virtualizer.scrollToIndex(position, { align: align === "center" ? "center" : "auto", behavior: "auto" });
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  const findNode = (key: string): HTMLElement | undefined =>
    Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("article[data-key]") ?? []).find((item) => item.dataset.key === key);

  // E M-2: focus that dropped to <body> because a commit removed or disabled the element that held it inside a row (a
  // decision's option once its answered row arrives) goes back to that row's article, through the pending focus below.
  // Focus the reader moved elsewhere, or sent nowhere from an element still in place, clears `lastFocus` first.
  useLayoutEffect(() => {
    const last = lastFocus.current;
    const doc = scrollRef.current?.ownerDocument;
    if (last === null || doc === undefined || pendingFocus.current !== null) return;
    const active = doc.activeElement;
    if (active !== null && active !== doc.body && active !== doc.documentElement) return;
    if (last.element.isConnected && !isDisabled(last.element)) return;
    lastFocus.current = null;
    focusKey.current = last.key;
    pendingFocus.current = last.key;
    // focusKey keeps the row in the virtual range; a row already out of it mounts on the next render.
    if (findNode(last.key) === undefined) rerender();
  });

  // Consumes a pending focus request once its row is mounted (focusKey keeps the row in the range meanwhile).
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    if (!builtRef.current.rows.some((row) => row.key === key)) {
      pendingFocus.current = null;
      return;
    }
    const node = findNode(key);
    if (node === undefined) return;
    pendingFocus.current = null;
    node.focus({ preventScroll: true });
  });

  const focusRow = (id: SelectionId | null): void => {
    const at = rowIndexOfSelection(builtRef.current, live.current.session, live.current.index, id);
    const row = builtRef.current.rows[at];
    if (row === undefined) return;
    focusKey.current = row.key;
    revealRef.current(at);
    const node = findNode(row.key);
    if (node !== undefined) {
      node.focus({ preventScroll: true });
      return;
    }
    pendingFocus.current = row.key;
    rerender();
  };
  const focusRowRef = useRef(focusRow);
  focusRowRef.current = focusRow;

  // G, the pills and the title bar's Live (lane ruling I-1): Live on and the tail in view, never a selection, so the
  // Brief stays when nothing is selected and an existing selection is kept. A finished session only scrolls there.
  const goToTail = (): void => {
    endReaderScroll();
    const current = live.current;
    if (!current.terminal) store.dispatch({ type: "follow/set", follow: true });
    if (current.session !== null) store.dispatch({ type: "seen", seq: current.session.loadedThroughSeq });
    const count = builtRef.current.rows.length;
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end", behavior: "auto" });
  };
  const goToTailRef = useRef(goToTail);
  goToTailRef.current = goToTail;

  const port = useMemo<ViewPort>(
    () => ({
      readingOrder: () => consoleReadingOrder(builtRef.current.rows),
      reveal: (id) => {
        const at = rowIndexOfSelection(builtRef.current, live.current.session, live.current.index, id);
        if (at >= 0) revealRef.current(at);
      },
      captureCamera: () => null,
      focusSelected: () => focusRowRef.current(store.get().selection),
      // Enter is always the Console's: it never falls back to toggling Hybrid's expansion of the step.
      toggle: (id) => {
        const at = rowIndexOfSelection(builtRef.current, live.current.session, live.current.index, id);
        const row = builtRef.current.rows[at];
        if (row !== undefined && isExpandable(row)) store.dispatch({ type: "expand/toggle", key: expandKey(row) });
        return true;
      },
      goToTail: () => {
        goToTailRef.current();
        return true;
      },
      newCount: () => consoleNewRowCount(builtRef.current, live.current.index, store.get().lastSeenSeq),
      zoom: NO_ZOOM,
    }),
    [store],
  );
  useRegisterViewPort("console", port);
  // The title bar reads newCount() through the port. It renders before the Console in a commit, so it may have read the
  // previous rows: tell it whenever the rows or the count change, not only when the Console's own count changes.
  const registry = useContext(ViewPortRegistryContext);
  useLayoutEffect(() => {
    if (active) registry?.notify();
  }, [built, newCount, active, registry]);

  // Opening (or showing) the Console: a following Console starts at the tail, a reviewing one at its selection.
  // The reset lives in the cleanup: under <Activity mode="hidden"> React runs cleanups but never the body of an
  // effect rendered while hidden, so an `!active` branch would not run and a re-shown Console would keep its old place.
  const positioned = useRef(false);
  useLayoutEffect(() => {
    if (!active) return undefined;
    if (positioned.current || rows.length === 0) return undefined;
    positioned.current = true;
    if (store.get().follow) virtualizer.scrollToIndex(rows.length - 1, { align: "end", behavior: "auto" });
    else if (selectedIndex >= 0) reveal(selectedIndex);
    return () => {
      positioned.current = false;
    };
  }, [active, rows.length === 0]);

  // A selection written elsewhere (keys, search, another view, the Brief) reveals its row. A Console click never
  // scrolls, and a data rebuild never moves the reader. Only a change of the selected id reveals: focusRev also moves
  // when a live brush slides with the tail, from the Shell's session/applied in a later commit than the rebuild, and
  // that bump must not pull a following Console back to the old tail (V-4 fix round 1).
  const lastSelection = useRef(selection);
  useLayoutEffect(() => {
    const before = lastSelection.current;
    lastSelection.current = selection;
    if (before === selection || selection === null) return;
    if (!active || focusBy === "console") return;
    const target = selectedIndex >= 0 ? selectedIndex : selection === index.tailStepId ? rows.length - 1 : -1;
    if (target >= 0) reveal(target);
  }, [focusBy, active, selectedIndex, selection]);

  // The Outline or the Brief picked the item that is already selected: no selection change, but the reader asked to see it.
  const lastRevealRev = useRef(revealRev);
  useLayoutEffect(() => {
    const before = lastRevealRev.current;
    lastRevealRev.current = revealRev;
    if (before === revealRev || !active) return;
    const target = selectedIndex >= 0 ? selectedIndex : selection !== null && selection === index.tailStepId ? rows.length - 1 : -1;
    if (target >= 0) reveal(target);
  }, [revealRev, active]);

  // Live turning on (the pill, G, the title bar) goes to the tail; the reader's own scroll there is already at it.
  const wasFollowing = useRef(follow);
  useLayoutEffect(() => {
    const before = wasFollowing.current;
    wasFollowing.current = follow;
    if (!follow || before || !active || rows.length === 0) return;
    endReaderScroll();
    virtualizer.scrollToIndex(rows.length - 1, { align: "end", behavior: "auto" });
  }, [follow, active]);

  // Selftest drift (viewer spec §10 "Anchor drift"): the top row must not move when rows arrive under a reviewing reader.
  useLayoutEffect(() => {
    if (!diagnostics.enabled || !active) return undefined;
    const before = anchor.current;
    const element = scrollRef.current;
    const view = viewOf();
    if (before === null || element === null || view === null) return undefined;
    // `before` is the anchor's DOM top from the last frame BEFORE this commit (frameHandler and the previous sample read
    // it from the DOM), so a shift the commit itself caused (rows inserted above, an uncompensated height change) is
    // part of the drift. Reading the baseline here would be after React applied the commit's mutations.
    const id = view.requestAnimationFrame(() => {
      const node = findNode(before.key);
      if (node === undefined) return;
      const top = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
      // Only the reader's own input since the last sample re-baselines it; following moves the list on purpose.
      if (readerMoved.current) readerMoved.current = false;
      else if (!store.get().follow) diagnostics.reportDrift(Math.abs(top - before.top));
      anchor.current = { key: before.key, top };
    });
    return () => view.cancelAnimationFrame(id);
  }, [built, diagnostics, active]);

  // Spec §11 append latency: every commit that rebuilt the rows measures from the oldest release to the next paint.
  // Releases that landed while the Console was hidden are stale: a re-shown Console must not measure from them. Under
  // <Activity mode="hidden"> only cleanups run (an effect body rendered while hidden never does), so the cleanup drops
  // the marks at hide, and showing again drops those that arrived during the hidden time.
  useLayoutEffect(() => {
    const clear = (): void => {
      if (typeof performance !== "undefined") performance.clearMarks(ROWS_RELEASED_MARK);
    };
    if (active) clear();
    return clear;
  }, [active]);
  useLayoutEffect(() => {
    if (active) measureFromFirstAfterPaint(PERF.consoleAppend, ROWS_RELEASED_MARK);
  }, [built, active]);

  const [query, setQuery] = useState("");
  useEffect(() => {
    if (search === null) setQuery("");
  }, [search]);
  const searchIndex = useRef<{ session: TraceSession; index: SearchIndex } | null>(null);
  const onSearchChange = (value: string): void => {
    setQuery(value);
    if (session === null) return;
    if (searchIndex.current?.session !== session) searchIndex.current = { session, index: buildSearchIndex(session) };
    dispatch({ type: "search/set", query: value, matchIds: searchMatches(session, searchIndex.current.index, value) });
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      dispatch({ type: "search/next", dir: event.shiftKey ? -1 : 1 });
      // A single match is already selected, so the selection does not change: reveal it anyway.
      const id = store.get().selection;
      if (id !== null) port.reveal(id, { animate: false });
    } else if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "esc" });
      scrollRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
    }
  };

  const selectRow = (row: ConsoleRow): void => {
    const id = consoleRowStepIds(row)[0];
    if (id !== undefined) dispatch({ type: "select", id: id as SelectionId, by: "console" });
  };
  // Answer state is the viewer's (shell/decision-answers.ts), by decision id: it survives the row scrolling out of the
  // virtual range and the Brief's cards share it. An answer sending or sent takes no second one (the runtime would
  // reject it) until the trace shows the decision answered.
  const { states: answers, answer } = useDecisionAnswers();

  if (session === null) {
    return (
      <div className={styles.console} data-console="">
        <div className={styles.placeholders} aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <div key={n} className={styles.placeholder} />
          ))}
        </div>
      </div>
    );
  }

  const empty =
    rows.length > 0
      ? null
      : session.loadedThroughSeq === 0
        ? "Waiting for the agent's first event"
        : `${session.loadedThroughSeq.toLocaleString("en-US")} events, none describe agent work`;
  const tabKey = (focusIndex >= 0 ? rows[focusIndex]?.key : undefined) ?? rows[selectedIndex]?.key ?? rows.at(-1)?.key ?? null;
  const newProblems = session.findings.filter((finding) => finding.severity === "critical" && finding.anchorSeq > lastSeenSeq).length;
  const now = nowT();
  const steps = `${session.steps.length.toLocaleString("en-US")} ${session.steps.length === 1 ? "step" : "steps"}`;

  return (
    <div className={styles.console} data-console="" data-step-count={session.steps.length}>
      <div className={styles.bar}>
        <span className={styles.count}>{follow || terminal ? steps : `Review · ${steps}`}</span>
        <label className={styles.search}>
          <Icon name="search" size={14} />
          <input
            data-view-search=""
            type="search"
            aria-label="Search the Console"
            placeholder="Search"
            value={query}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </label>
      </div>
      {empty === null ? null : <p className={styles.empty}>{empty}</p>}
      <div
        ref={scrollRef}
        className={styles.scroll}
        data-scroll-root=""
        data-console-scroll=""
        role="feed"
        aria-label="Console"
        aria-busy={loadedFraction < 1}
      >
        <div className={styles.sizer} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            const lineId = `console-line:${row.key}`;
            return (
              <article
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-key={row.key}
                data-kind={row.kind}
                data-selected={item.index === selectedIndex ? "" : undefined}
                data-match={rowMatches(row, matches) ? "" : undefined}
                aria-posinset={item.index + 1}
                aria-setsize={rows.length}
                aria-labelledby={row.kind === "summary" ? storySentenceIds(lineId, row.sentences.length) : lineId}
                tabIndex={row.key === tabKey ? 0 : -1}
                className={styles.slot}
                style={{ transform: `translateY(${item.start}px)` }}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) focusKey.current = row.key;
                  lastFocus.current = { key: row.key, element: event.target };
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (focusKey.current === row.key && next !== null && !event.currentTarget.contains(next)) focusKey.current = null;
                  const left = event.target;
                  if (lastFocus.current?.element !== left) return;
                  if (next !== null) {
                    lastFocus.current = null;
                    return;
                  }
                  // Focus sent nowhere from an element still in place (a click on empty space) was the reader's; one the
                  // commit removed or disabled (a browser may fire focusout for it) is the loss the repair restores.
                  queueMicrotask(() => {
                    if (lastFocus.current?.element === left && left.isConnected && !isDisabled(left)) lastFocus.current = null;
                  });
                }}
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest("button, a, input") !== null) return;
                  selectRow(row);
                }}
              >
                <ConsoleRowView
                  row={row}
                  session={session}
                  index={index}
                  expanded={expanded.has(expandKey(row))}
                  lineId={lineId}
                  nowT={isRunningRow(row) ? now : 0}
                  canAnswer={host.answerDecision !== undefined}
                  answer={row.kind === "decision" ? (answers.get(row.decisionId) ?? "idle") : "idle"}
                  payloads={fetchPayloads}
                  onToggle={() => dispatch({ type: "expand/toggle", key: expandKey(row) })}
                  onSelectStep={(id) => dispatch({ type: "select", id: id as SelectionId, by: "console" })}
                  onOpenDiff={() => {
                    selectRow(row);
                    dispatch({ type: "inspector/tab", tab: "evidence" });
                  }}
                  onAnswer={answer}
                />
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
            afterRange={false}
            noun="row"
            onActivate={() => goToTailRef.current()}
          />
        )}
      </div>
    </div>
  );
}
