import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { buildSpineRows } from "../../layout/spine-rows.js";
import { buildTimeScale, timeScaleInputOf, type TimeScale } from "../../layout/time-scale.js";
import {
  buildTraceIndex,
  emptyTraceIndex,
  type SelectionId,
  type TraceIndex,
} from "../../layout/trace-index.js";
import { compareFindings, resolveStableId, type StableId, type TraceSession } from "../../model/index.js";
import { IconSprite } from "../icons/IconSprite.js";
import { selectionTitle } from "../inspector/finding-copy.js";
import { Inspector } from "../inspector/Inspector.js";
import type { ViewerLocation } from "../state/location.js";
import { useViewStore } from "../state/store.js";
import { locationOf } from "../state/view-state.js";
import base from "../tokens/base.module.css";
import { tokenStyle } from "../tokens/tokens.js";
import { KEEP_HIDDEN_VIEWS_MOUNTED, VIEWS } from "../views/registry.js";
import {
  createViewPortRegistry,
  ViewDefinitionsContext,
  ViewPortRegistryContext,
  type ViewDefinition,
} from "../views/view-port.js";
import { isLiveState, LIVE_TICK_START, type DataController, type DataSnapshot } from "./data-controller.js";
import type { ViewerHost } from "./host.js";
import { LiveRegion } from "./LiveRegion.js";
import { Outline } from "./Outline/Outline.js";
import { INITIAL_SELECTION_PAINTED, markAfterPaint, markNextFrame, measureAfterPaint, PERF } from "./perf.js";
import { DiagnosticsContext, SessionContext, type DiagnosticsSink, type SessionView } from "./session-context.js";
import { KeyboardLayer } from "./KeyboardLayer.js";
import styles from "./Shell.module.css";
import { TitleBar } from "./TitleBar.js";
import { ViewSlot } from "./ViewSlot.js";

export interface ShellProps {
  sessionId: string;
  host: ViewerHost;
  controller: DataController;
  location?: ViewerLocation;
  /** Overrides "running opens in Live" (the selftest drips in Review). */
  initialFollow?: boolean;
}

const EMPTY_SCALE_INPUT = { originMs: 0, work: [], awaitingFrom: [] } as const;

const SHELL_VIEWS: readonly ViewDefinition[] = VIEWS;
const KEEP_HIDDEN = KEEP_HIDDEN_VIEWS_MOUNTED;

/** Maps a location's stable id to what the store selects: step and unit ids (spec §7.8). */
export function selectionFromStableId(session: TraceSession, id: StableId): SelectionId | null {
  const target = resolveStableId(session, id);
  if (target === null) return null;
  switch (target.kind) {
    case "step":
    case "decision":
      return target.step.id;
    case "unit":
      return target.chapter.id;
    case "file":
      return target.entity.stepIds.at(-1) ?? null;
    case "finding":
      return target.finding.anchorStepId;
  }
}

/** Spec §7.8 "Defaults on open": the location's selection, else the first finding under FINDING_ORDER, else the last step. */
function initialSelectionOf(session: TraceSession, location: ViewerLocation | undefined): SelectionId | null {
  if (location?.selected !== undefined) {
    const resolved = selectionFromStableId(session, location.selected as StableId);
    if (resolved !== null) return resolved;
  }
  const top = [...session.findings].sort(compareFindings)[0];
  if (top !== undefined) return top.anchorStepId;
  return session.steps.at(-1)?.id ?? null;
}

function chapterSpineRowCount(session: TraceSession, index: TraceIndex, scale: TimeScale, terminal: boolean): number {
  return buildSpineRows(session, index, scale, {
    brush: { kind: "session" },
    level: "chapter",
    playheadSeq: session.loadedThroughSeq,
    selection: null,
    expanded: new Set<string>(),
    collapsed: new Set<string>(),
    live: !terminal,
  }).length;
}

function originOf(session: TraceSession | null, snapshot: DataSnapshot): number {
  if (session !== null) return session.originMs;
  const started = snapshot.summary === null ? Number.NaN : Date.parse(snapshot.summary.startedAt);
  return Number.isFinite(started) ? started : 0;
}

function selectedTitleFor(
  session: TraceSession | null,
  index: TraceIndex,
  selection: SelectionId | null,
): string | null {
  return session === null || selection === null ? null : selectionTitle(session, index, selection);
}

export const MAX_REPORTED_ERRORS = 50;

/** Appends `item`, dropping the oldest entries beyond `cap`. */
export function appendCapped<T>(list: readonly T[], item: T, cap: number): T[] {
  const next = [...list, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function Shell({ sessionId, host, controller, location, initialFollow }: ShellProps) {
  const store = useViewStore();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // The open location and follow override apply once, at open; a parent passing a fresh
  // equal `location` object each render must not re-run the open logic.
  const openOptions = useRef({ location, initialFollow });
  const [snapshot, setSnapshot] = useState<DataSnapshot>(() => controller.get());

  useEffect(() => {
    setSnapshot(controller.get());
    return controller.subscribe((next) => startTransition(() => setSnapshot(next)));
  }, [controller]);

  // Applies wait for a gesture to end (spec §7.10): a store gesture holds the controller.
  useEffect(() => {
    let held = false;
    const sync = (): void => {
      const next = store.get().gesture !== null;
      if (next !== held) {
        held = next;
        controller.hold(next);
      }
    };
    sync();
    return store.subscribe(sync);
  }, [store, controller]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") controller.notifyVisible();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [controller]);

  const session = snapshot.session;
  const index = useMemo(
    () => (session === null ? emptyTraceIndex(sessionId) : buildTraceIndex(session)),
    [session, sessionId],
  );
  const scale = useMemo<TimeScale>(() => {
    if (session === null) return buildTimeScale(EMPTY_SCALE_INPUT);
    const lastT = session.steps.at(-1)?.tMs ?? 0;
    const liveTMs = session.live ? Math.max(lastT, controller.now() - session.originMs) : undefined;
    return buildTimeScale(timeScaleInputOf(session, liveTMs));
  }, [session, controller]);

  const sessionView = useMemo<SessionView>(() => {
    const origin = originOf(session, snapshot);
    return {
      summary: snapshot.summary,
      session,
      index,
      scale,
      status: snapshot.status,
      loadedFraction: snapshot.loadedFraction,
      terminal: snapshot.terminal,
      nowT: () => controller.now() - origin,
      payloads: (seqs) => controller.payloads(seqs),
      retry: () => controller.retry(),
    };
  }, [snapshot, session, index, scale, controller]);

  const registry = useMemo(() => createViewPortRegistry(), []);

  const current = useRef({ session, index });
  current.current = { session, index };
  const diagnosticsState = useRef({ errors: [] as string[], maxAnchorDriftPx: 0 });
  const diagnostics = useMemo<DiagnosticsSink>(() => {
    const flush = (): void => {
      if (host.onDiagnostics === undefined) return;
      const { session: s, index: i } = current.current;
      host.onDiagnostics({
        errors: [...diagnosticsState.current.errors],
        maxAnchorDriftPx: diagnosticsState.current.maxAnchorDriftPx,
        selectedTitle: selectedTitleFor(s, i, store.get().selection),
      });
    };
    return {
      enabled: host.onDiagnostics !== undefined,
      reportDrift(px) {
        diagnosticsState.current.maxAnchorDriftPx = Math.max(diagnosticsState.current.maxAnchorDriftPx, px);
        flush();
      },
      reportError(message) {
        diagnosticsState.current.errors = appendCapped(
          diagnosticsState.current.errors,
          message,
          MAX_REPORTED_ERRORS,
        );
        flush();
      },
      flush,
    };
  }, [host, store]);

  useEffect(() => (diagnostics.enabled ? store.subscribe(diagnostics.flush) : undefined), [diagnostics, store]);

  const opened = useRef({ follow: false, ready: false, fullLoad: false });
  const cancelSelectionMark = useRef<() => void>(() => undefined);
  useEffect(() => () => cancelSelectionMark.current(), []);
  useLayoutEffect(() => {
    const flags = opened.current;
    if (!flags.follow && snapshot.summary !== null) {
      flags.follow = true;
      store.dispatch({ type: "follow/set", follow: openOptions.current.initialFollow ?? isLiveState(snapshot.summary.state) });
    }
    store.setIndex(index);
    if (session === null) return;
    const loadComplete = snapshot.loadedFraction >= 1;
    const needsDefaults = loadComplete && !store.get().loaded;
    const selectedBefore = store.get().selection;
    store.dispatch({
      type: "session/applied",
      loadedThroughSeq: session.loadedThroughSeq,
      terminal: snapshot.terminal,
      loadComplete,
      initialSelection: needsDefaults ? initialSelectionOf(session, openOptions.current.location) : null,
      chapterSpineRows: needsDefaults ? chapterSpineRowCount(session, index, scale, snapshot.terminal) : 0,
    });
    // Spec §1: the dispatch re-renders the store's subscribers synchronously, before the next frame,
    // so the mark lands in the first rAF after the commit that applies the initial selection. A
    // session that opens in Live gets no initial selection and no mark.
    if (needsDefaults && selectedBefore === null && store.get().selection !== null) {
      cancelSelectionMark.current();
      cancelSelectionMark.current = markNextFrame(INITIAL_SELECTION_PAINTED);
    }
    if (!flags.ready) {
      flags.ready = true;
      host.onReady?.({ rows: snapshot.rows, loadedThroughSeq: session.loadedThroughSeq });
    }
    if (loadComplete && !flags.fullLoad) {
      flags.fullLoad = true;
      markAfterPaint(PERF.fullLoad, PERF.bundleParsed);
    } else if (flags.fullLoad) {
      // Spec §10 live tick (poll apply + selectors + commit), measured unconditionally: the
      // Electron trace window has no HUD and lane 08 D-8 reads tv:live-tick from it.
      measureAfterPaint(PERF.liveTick, LIVE_TICK_START);
    }
    diagnostics.flush();
  }, [snapshot, session, index, scale, store, host, diagnostics]);

  useEffect(() => {
    if (host.onLocation === undefined) return undefined;
    let last = "";
    const emit = (): void => {
      const next = locationOf(store.get(), sessionId);
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      host.onLocation?.(next);
    };
    emit();
    return store.subscribe(emit);
  }, [store, host, sessionId]);

  const hiddenRows =
    session === null
      ? 0
      : Object.values(session.hidden.byType).reduce<number>((sum, count) => sum + (count ?? 0), 0) +
        session.hidden.unreceived;
  return (
    <div
      ref={setRoot}
      className={`${base.root} ${styles.root}`}
      style={tokenStyle() as CSSProperties}
      data-trace-viewer=""
    >
      <IconSprite />
      <SessionContext.Provider value={sessionView}>
        <DiagnosticsContext.Provider value={diagnostics}>
          <ViewPortRegistryContext.Provider value={registry}>
            <ViewDefinitionsContext.Provider value={SHELL_VIEWS}>
              <LiveRegion>
                <div className={styles.grid}>
                  <header className={styles.title} data-region="title">
                    <TitleBar onRetry={() => controller.retry()} />
                  </header>
                  <nav className={styles.outline} aria-label="Outline" data-region="outline">
                    <Outline hiddenRows={hiddenRows} />
                  </nav>
                  <main className={styles.main} data-region="main" tabIndex={-1}>
                    <ViewSlot views={SHELL_VIEWS} keepHiddenMounted={KEEP_HIDDEN} />
                  </main>
                  <aside className={styles.inspector} aria-label="Inspector" data-region="inspector">
                    <Inspector host={host} />
                  </aside>
                </div>
                <KeyboardLayer root={root} />
              </LiveRegion>
            </ViewDefinitionsContext.Provider>
          </ViewPortRegistryContext.Provider>
        </DiagnosticsContext.Provider>
      </SessionContext.Provider>
    </div>
  );
}
