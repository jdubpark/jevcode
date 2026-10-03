import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";

import type { TraceRow } from "@jevcode/contracts";

import { buildConsoleRows, consoleRowStepIds, type ConsoleRow, type ConsoleRowsState } from "../../../layout/console-rows.js";
import type { SelectionId, TraceIndex } from "../../../layout/trace-index.js";
import { buildSearchIndex, type SearchIndex, type TraceSession } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import { useViewerHost } from "../../shell/host-context.js";
import { useAnnounce } from "../../shell/LiveRegion.js";
import { searchMatches } from "../../shell/Outline/outline-rows.js";
import { useDiagnostics, useSessionView } from "../../shell/session-context.js";
import { useDispatch, useView, useViewStore } from "../../state/store.js";
import { selectNewCount } from "../../state/view-state.js";
import { extendRange, revealAlign, spineVirtualOptions } from "../hybrid/spine/scroll-sync.js";
import { NewBadge } from "../shared/NewBadge.js";
import { useRegisterViewPort, type ViewPort, type ViewProps, type ZoomPort } from "../view-port.js";
import { ConsoleRowView, estimateConsoleRow, expandKey, isExpandable } from "./ConsoleRowView.js";
import styles from "./ConsoleView.module.css";

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

/** j/k order: one entry per row that shows a step (a read group stands for its first read); finding rows are skipped. */
export function consoleReadingOrder(rows: readonly ConsoleRow[]): SelectionId[] {
  const order: SelectionId[] = [];
  for (const row of rows) {
    if (row.kind === "finding" || row.kind === "summary") continue;
    const first = consoleRowStepIds(row)[0];
    if (first !== undefined) order.push(first as SelectionId);
  }
  return order;
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
  const announce = useAnnounce();
  const diagnostics = useDiagnostics();
  const follow = useView((state) => state.follow);
  const selection = useView((state) => state.selection);
  const expanded = useView((state) => state.expanded);
  const search = useView((state) => state.search);
  const focusRev = useView((state) => state.focusRev);
  const focusBy = useView((state) => state.focusBy);
  const lastSeenSeq = useView((state) => state.lastSeenSeq);
  const newCount = useView((state) => selectNewCount(state, index));
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
  const selectedIndex = rowIndexOfSelection(built, session, index, selection);

  const scrollRef = useRef<HTMLDivElement>(null);
  const focusKey = useRef<string | null>(null);
  /** Set by a focus request (port.focusSelected); consumed once its row is mounted, so a rebuild never moves focus. */
  const pendingFocus = useRef<string | null>(null);
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
  });

  // Coalesced per frame: remember the top row (drift), and let the reader's own scroll turn Live off and on.
  frameHandler.current = (): void => {
    const element = scrollRef.current;
    const current = live.current.session;
    if (element === null || current === null) return;
    const offset = virtualizer.scrollOffset ?? element.scrollTop;
    const height = virtualizer.scrollRect?.height || element.clientHeight;
    const first = virtualizer.getVirtualItems().find((item) => item.end > offset);
    const firstRow = first === undefined ? undefined : builtRef.current.rows[first.index];
    if (first !== undefined && firstRow !== undefined) anchor.current = { key: firstRow.key, top: first.start - offset };
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

  const port = useMemo<ViewPort>(
    () => ({
      readingOrder: () => consoleReadingOrder(builtRef.current.rows),
      reveal: (id) => {
        const at = rowIndexOfSelection(builtRef.current, live.current.session, live.current.index, id);
        if (at >= 0) revealRef.current(at);
      },
      captureCamera: () => null,
      focusSelected: () => focusRowRef.current(store.get().selection),
      toggle: (id) => {
        const at = rowIndexOfSelection(builtRef.current, live.current.session, live.current.index, id);
        const row = builtRef.current.rows[at];
        if (row === undefined || !isExpandable(row)) return false;
        store.dispatch({ type: "expand/toggle", key: expandKey(row) });
        return true;
      },
      zoom: NO_ZOOM,
    }),
    [store],
  );
  useRegisterViewPort("console", port);

  // Opening (or showing) the Console: a following Console starts at the tail, a reviewing one at its selection.
  const positioned = useRef(false);
  useLayoutEffect(() => {
    if (!active) {
      positioned.current = false;
      return;
    }
    if (positioned.current || rows.length === 0) return;
    positioned.current = true;
    if (store.get().follow) virtualizer.scrollToIndex(rows.length - 1, { align: "end", behavior: "auto" });
    else if (selectedIndex >= 0) reveal(selectedIndex);
  }, [active, rows.length === 0]);

  // A selection written elsewhere (keys, search, another view, the Brief) reveals its row. A Console click never
  // scrolls, and a data rebuild never moves the reader: a commit that brings a new session and keeps the selection
  // (a live brush sliding with the tail bumps focusRev) reveals nothing.
  const lastReveal = useRef({ rev: focusRev, selection, session });
  useLayoutEffect(() => {
    const before = lastReveal.current;
    lastReveal.current = { rev: focusRev, selection, session };
    if (before.rev === focusRev) return;
    if (!active || focusBy === "console") return;
    if (before.selection === selection && before.session !== session) return;
    const target = selectedIndex >= 0 ? selectedIndex : selection !== null && selection === index.tailStepId ? rows.length - 1 : -1;
    if (target >= 0) reveal(target);
  }, [focusRev, focusBy, active, selectedIndex, selection, session]);

  // Selftest drift (viewer spec §10 "Anchor drift"): the top row must not move when rows arrive under a reviewing reader.
  useLayoutEffect(() => {
    if (!diagnostics.enabled || !active) return undefined;
    const before = anchor.current;
    const element = scrollRef.current;
    const view = viewOf();
    if (before === null || element === null || view === null) return undefined;
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
  const answer = async (decisionId: string, optionId: string): Promise<void> => {
    if (host.answerDecision === undefined) return;
    try {
      await host.answerDecision({ decisionId, optionId });
      announce("Answer sent");
    } catch {
      announce("Could not send the answer");
    }
  };

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
                aria-labelledby={lineId}
                tabIndex={row.key === tabKey ? 0 : -1}
                className={styles.slot}
                style={{ transform: `translateY(${item.start}px)` }}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) focusKey.current = row.key;
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (focusKey.current === row.key && next !== null && !event.currentTarget.contains(next)) focusKey.current = null;
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
                  nowT={now}
                  canAnswer={host.answerDecision !== undefined}
                  payloads={fetchPayloads}
                  onToggle={() => dispatch({ type: "expand/toggle", key: expandKey(row) })}
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
            onActivate={() => {
              dispatch({ type: "nav/last" });
              if (!terminal) dispatch({ type: "follow/set", follow: true });
            }}
          />
        )}
      </div>
    </div>
  );
}
