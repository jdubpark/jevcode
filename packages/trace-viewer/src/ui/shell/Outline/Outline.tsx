import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { buildSearchIndex, formatOffset, type SearchIndex, type TraceSession } from "../../../model/index.js";
import { Graphic } from "../../graphics/Graphic.js";
import { Icon } from "../../icons/Icon.js";
import { useDispatch, useView } from "../../state/store.js";
import { selectEffectivePlayheadSeq } from "../../state/view-state.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { useSessionView } from "../session-context.js";
import {
  buildOutlineRows,
  DEFAULT_OPEN_SECTIONS,
  fileTitleBudget,
  searchMatches,
  storyTitleBudget,
  type OutlineRow,
  type OutlineSection,
} from "./outline-rows.js";
import styles from "./Outline.module.css";

export interface OutlineProps {
  hiddenRows: number;
}

const ROW_PX = 28;

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function OutlineBody({ hiddenRows }: OutlineProps) {
  const { session, index } = useSessionView();
  const dispatch = useDispatch();
  const selection = useView((state) => state.selection);
  const search = useView((state) => state.search);
  const playheadSeq = useView((state) => selectEffectivePlayheadSeq(state, index));
  const [open, setOpen] = useState<ReadonlySet<OutlineSection>>(DEFAULT_OPEN_SECTIONS);
  const [showAll, setShowAll] = useState<ReadonlySet<OutlineSection>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // Rows of different sections can share one step; the row the user chose is the selected one.
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [query, setQuery] = useState(search?.query ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const [columnW, setColumnW] = useState(0);
  const fileTitleMax = fileTitleBudget(columnW);
  const storyTitleMax = storyTitleBudget(columnW);

  // Files basenames are cut in the middle to what the column holds (216 px, 200 px under 1180 px).
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return undefined;
    const apply = (width: number): void => {
      if (width > 0) setColumnW(Math.round(width));
    };
    apply(element.getBoundingClientRect().width);
    const Observer = element.ownerDocument.defaultView?.ResizeObserver;
    if (typeof Observer !== "function") return undefined;
    const observer = new Observer((entries) => {
      const entry = entries[0];
      apply(entry?.contentBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (search === null) setQuery("");
  }, [search]);

  const rows = useMemo<OutlineRow[]>(
    () => (session === null ? [] : buildOutlineRows(session, { open, showAll, fileTitleMax, storyTitleMax })),
    [session, open, showAll, fileTitleMax, storyTitleMax],
  );
  // Built on the first keystroke for a session, not per Live commit (only a query reads it).
  const searchIndex = useRef<{ session: TraceSession; index: SearchIndex } | null>(null);
  const searchIndexOf = (current: TraceSession): SearchIndex => {
    if (searchIndex.current?.session !== current) searchIndex.current = { session: current, index: buildSearchIndex(current) };
    return searchIndex.current.index;
  };
  const matches = useMemo(() => new Set<string>(search?.matchIds ?? []), [search]);
  const currentChapter = session === null ? undefined : index.chapterAtSeq(playheadSeq)?.id;

  const isSelected = (row: OutlineRow): boolean =>
    row.t === "item" && selection !== null && (row.selId === selection || row.alsoSelects === selection);
  const selectedKey = (rows.find((row) => row.key === chosenKey && isSelected(row)) ?? rows.find(isSelected))?.key;
  const tabKey =
    focusKey !== null && rows.some((row) => row.key === focusKey) ? focusKey : (selectedKey ?? rows[0]?.key ?? null);

  // The roving row and the selected rows stay mounted however far they scroll, so exactly one
  // mounted row keeps tabindex=0 and Tab always finds the tree.
  const pinned = useMemo(() => {
    const positions: number[] = [];
    rows.forEach((row, position) => {
      if (row.key === tabKey || (row.t === "item" && (row.selId === selection || row.alsoSelects === selection))) {
        positions.push(position);
      }
    });
    return positions;
  }, [rows, tabKey, selection]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    getItemKey: (position) => rows[position]?.key ?? position,
    overscan: 8,
    rangeExtractor: (range) =>
      Array.from(new Set([...defaultRangeExtractor(range), ...pinned.filter((position) => position < range.count)])).sort(
        (a, b) => a - b,
      ),
  });

  // Focus moves only after a keyboard move; a rows rebuild (Live poll) never steals it.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    const position = rows.findIndex((row) => row.key === target);
    if (position < 0) {
      pendingFocus.current = null;
      return;
    }
    virtualizer.scrollToIndex(position, { align: "auto" });
    const frame = requestAnimationFrame(() => {
      pendingFocus.current = null;
      const element = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []).find(
        (node) => node.dataset.key === target,
      );
      element?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey, rows, virtualizer]);

  const activate = (row: OutlineRow): void => {
    if (row.t === "section") setOpen((current) => toggled(current, row.section));
    else if (row.t === "more") setShowAll((current) => toggled(current, row.section));
    else if (row.t === "item") {
      setChosenKey(row.key);
      dispatch({ type: "select", id: row.selId, by: "shell" });
      if (row.openEvidence) dispatch({ type: "inspector/tab", tab: "evidence" });
    }
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const position = rows.findIndex((row) => row.key === tabKey);
    const move = (to: number): void => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (row === undefined) return;
      pendingFocus.current = row.key;
      setFocusKey(row.key);
    };
    const row = rows[position];
    switch (event.key) {
      case "ArrowDown":
        move(position + 1);
        break;
      case "ArrowUp":
        move(position - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (row?.t === "section" && !row.open) activate(row);
        break;
      case "ArrowLeft":
        if (row?.t === "section" && row.open) activate(row);
        break;
      case "Enter":
        if (row !== undefined) activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onSearchChange = (value: string): void => {
    setQuery(value);
    if (session === null) return;
    dispatch({ type: "search/set", query: value, matchIds: searchMatches(session, searchIndexOf(session), value) });
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      dispatch({ type: "search/next", dir: event.shiftKey ? -1 : 1 });
    } else if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "esc" });
      const root = event.currentTarget.closest("[data-trace-viewer]");
      root
        ?.querySelector<HTMLElement>('[data-region="main"] [tabindex="0"], [data-region="main"]')
        ?.focus({ preventScroll: true });
    }
  };

  const noMatches = query.trim() !== "" && search !== null && search.matchIds.length === 0;

  return (
    <div className={styles.outline}>
      <div className={styles.header}>
        <h2 className={styles.heading}>Outline</h2>
        <label className={styles.search}>
          <Icon name="search" size={14} />
          <input
            data-outline-search=""
            type="search"
            aria-label="Search steps"
            placeholder="Search"
            value={query}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </label>
      </div>
      {noMatches ? (
        <p className={styles.empty}>
          {`No steps match “${query}” · `}
          <button type="button" className={styles.clear} onClick={() => onSearchChange("")}>
            Clear
          </button>
        </p>
      ) : null}
      <div
        ref={scrollRef}
        className={styles.scroll}
        role="tree"
        aria-label="Outline"
        data-scroll-root=""
        onKeyDown={onTreeKeyDown}
      >
        {session === null ? (
          <div aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <div key={n} className={styles.placeholder} />
            ))}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              const common = {
                "data-key": row.key,
                "data-index": item.index,
                "aria-setsize": rows.length,
                "aria-posinset": item.index + 1,
                tabIndex: row.key === tabKey ? 0 : -1,
                style: { transform: `translateY(${item.start}px)` },
                onFocus: () => setFocusKey(row.key),
              };
              if (row.t === "section") {
                return (
                  <div
                    key={row.key}
                    {...common}
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={row.open}
                    className={`${styles.row} ${styles.section}`}
                    onClick={() => activate(row)}
                  >
                    <Icon name={row.open ? "chev-d" : "chev-r"} size={12} />
                    <span className={styles.title}>{row.label}</span>
                    <span className={styles.count}>{row.count}</span>
                  </div>
                );
              }
              if (row.t === "turn") {
                return (
                  <div key={row.key} {...common} role="treeitem" aria-level={2} className={`${styles.row} ${styles.turn}`}>
                    <span className={styles.title}>{row.label}</span>
                    <span className={styles.offset}>{formatOffset(row.tMs)}</span>
                  </div>
                );
              }
              if (row.t === "more") {
                return (
                  <div
                    key={row.key}
                    {...common}
                    role="treeitem"
                    aria-level={2}
                    className={`${styles.row} ${styles.more}`}
                    onClick={() => activate(row)}
                  >
                    {`Show ${row.hidden} more`}
                  </div>
                );
              }
              return (
                <div
                  key={row.key}
                  {...common}
                  role="treeitem"
                  aria-level={row.depth + 2}
                  aria-label={row.label}
                  aria-selected={row.key === selectedKey}
                  aria-current={row.chapterId !== null && row.chapterId === currentChapter ? "true" : undefined}
                  data-depth={row.depth}
                  data-match={
                    matches.has(row.selId) || (row.alsoSelects !== undefined && matches.has(row.alsoSelects)) ? "" : undefined
                  }
                  className={styles.row}
                  onClick={() => activate(row)}
                >
                  <span className={styles.icon}>
                    <Icon name={row.icon} size={14} />
                  </span>
                  <span
                    className={`${styles.title} ${row.mono ? styles.mono : ""} ${row.muted ? styles.muted : ""}`}
                    title={row.hint}
                  >
                    {row.title}
                  </span>
                  {row.flag === "x" ? (
                    <span className={styles.flagBad} aria-hidden="true">
                      ✕
                    </span>
                  ) : null}
                  {row.failed ? <span className={styles.failedWord}>failed</span> : null}
                  {row.flag === "neq" ? (
                    <span className={styles.flagBad}>
                      <Icon name="neq" size={12} />
                    </span>
                  ) : null}
                  {row.flag === "shield" ? (
                    <span className={styles.flagIcon}>
                      <Icon name="shield" size={12} />
                    </span>
                  ) : null}
                  {row.graphic === null ? null : (
                    <span className={row.section === "files" ? styles.slot : styles.graphic}>
                      <Graphic spec={row.graphic} size="xs" />
                    </span>
                  )}
                  {row.section === "story" ? <span className={styles.offset}>{formatOffset(row.tMs)}</span> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {hiddenRows > 0 ? <p className={styles.footer}>{`${hiddenRows} pipeline rows hidden`}</p> : null}
    </div>
  );
}

/** Wraps itself in its own boundary (lane ruling): the Shell does not wrap regions. */
export function Outline(props: OutlineProps) {
  return (
    <ErrorBoundary region="Outline">
      <OutlineBody {...props} />
    </ErrorBoundary>
  );
}
