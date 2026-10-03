import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import type { TraceBundle } from "@jevcode/contracts";
import {
  createStaticBundleSource,
  locationFromHash,
  locationToHash,
  parseTraceBundle,
  PERF,
  TraceViewer,
  type DripOptions,
  type StaticBundleSource,
  type ViewerHost,
  type ViewKind,
} from "@jevcode/trace-viewer";

import styles from "./host.module.css";
import { loadOverview, withOverview } from "./overview-sample.js";
import { PerfHud } from "./perf-hud.js";
import { createSelftest, selftestDrip, type SelftestResult } from "./selftest.js";
import { createBarProbe, createMapHeadProbe, type BarProbeResult, type MapHeadProbeResult } from "./selftest-bar.js";
import { claimStepIdOf, createOpenProbe, type OpenProbeResult } from "./selftest-open.js";

/** A dropped file is untrusted input: refuse anything past this before reading it. The 177 MB soak bundle fits. */
const MAX_DROPPED_BYTES = 512 * 1024 * 1024;

export type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; bundle: TraceBundle };

/** "<rowsPerTick>,<intervalMs>[,<startAtSeq>]"; a negative startAtSeq is resolved against the bundle by resolveDrip. */
export function parseDrip(value: string | null): DripOptions | undefined {
  if (value === null) return undefined;
  const parts = value.split(",");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const [rows, interval, start] = parts.map((part) => Number(part));
  if (rows === undefined || interval === undefined) return undefined;
  if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(interval) || interval <= 0) return undefined;
  if (start === undefined) return { rowsPerTick: rows, intervalMs: interval };
  if (!Number.isInteger(start)) return undefined;
  return { rowsPerTick: rows, intervalMs: interval, startAtSeq: start };
}

const VIEW_KIND = /^[a-z][a-z0-9-]{0,31}$/;

/** `?view=console` etc.: the opening view when the hash names none (TraceViewerProps.initialView). */
export function parseView(value: string | null): ViewKind | undefined {
  return value !== null && VIEW_KIND.test(value) ? value : undefined;
}

/** `?gaps=N` (1 to 50): the count of unknown-type rows to append, so the fold reports N gaps and the title bar shows its chip. */
export function parseGaps(value: string | null): number {
  const count = Number(value);
  return value !== null && Number.isInteger(count) && count > 0 && count <= 50 ? count : 0;
}

/** Appends `count` rows of a type no build knows after the last row; the fold turns each into an unknown_row_type gap. */
export function withGapRows(bundle: TraceBundle, count: number): TraceBundle {
  if (count === 0) return bundle;
  const last = bundle.rows.at(-1);
  const lastSeq = last?.seq ?? 0;
  const ts = last?.ts ?? new Date(0).toISOString();
  const extra = Array.from({ length: count }, (_, index) => ({
    seq: lastSeq + index + 1,
    type: "dev_host_gap",
    ts,
    payload: {},
  }));
  return { ...bundle, rows: [...bundle.rows, ...extra] };
}

/**
 * `?frame=N` (320 to 2400): the embedded viewer's width in px, the main window's workspace column beside its sidebar.
 * The main window at its 880 px minimum gives the viewer 880 − 200 = 680 px (lane 03 fix wave minor 1).
 */
export function parseFrame(value: string | null): number | undefined {
  const width = Number(value);
  return value !== null && Number.isInteger(width) && width >= 320 && width <= 2400 ? width : undefined;
}

/**
 * `?approx=1`: each change unit cites fact ids no row carries and no agent call, as a session recorded before exact
 * step links did; the fold then joins its chapters by time window and the title bar shows the approximate-joins chip.
 */
export function withApproximateJoins(bundle: TraceBundle): TraceBundle {
  const rows = bundle.rows.map((row) => {
    if (row.type !== "change_unit" || typeof row.payload !== "object" || row.payload === null) return row;
    const payload = row.payload as { evidence?: unknown };
    const evidence = Array.isArray(payload.evidence)
      ? payload.evidence.map((id, index) => (typeof id === "string" && id.startsWith("fact_") ? `fact_devhost_unlinked_${index}` : id))
      : payload.evidence;
    return { ...row, payload: { ...payload, evidence, agentCallIds: [] } };
  });
  return { ...bundle, rows };
}

/** Spec §10 live tick run: "starting at lastSeq − 2000" is `?drip=20,1000,-2000`. */
export function resolveDrip(drip: DripOptions, bundle: TraceBundle): DripOptions {
  if (drip.startAtSeq === undefined || drip.startAtSeq >= 0) return drip;
  const lastSeq = bundle.rows.at(-1)?.seq ?? 0;
  return { ...drip, startAtSeq: Math.max(0, lastSeq + drip.startAtSeq) };
}

/** Spec §10: tv:bundle-parsed is marked right after JSON.parse and before schema validation. */
export function parseBundleText(text: string): Loaded {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "error", message: "Not a jevcode trace" };
  }
  performance.mark(PERF.bundleParsed);
  const parsed = parseTraceBundle(json);
  return parsed.ok ? { kind: "ready", bundle: parsed.bundle } : { kind: "error", message: parsed.message };
}

async function loadBundle(name: string): Promise<Loaded> {
  const url = `bundles/${encodeURIComponent(name)}.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) return { kind: "error", message: `Could not load ${url} (HTTP ${response.status})` };
    return parseBundleText(await response.text());
  } catch (error) {
    return { kind: "error", message: `Could not load ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** `?languages=A,B,C`: the overview's languages by file count, for a header whose list is longer than the fixture's. */
export function parseLanguages(value: string | null): string[] | null {
  const languages = (value ?? "").split(",").map((language) => language.trim()).filter((language) => language !== "");
  return languages.length === 0 ? null : languages.slice(0, 8);
}

/** ?overview=<name>: appends its overview_snapshot rows to the loaded bundle (dev host only). */
async function attachOverview(bundle: TraceBundle, name: string, languages: string[] | null): Promise<Loaded> {
  const snapshots = await loadOverview(name, bundle.session.sessionId);
  if (snapshots === null) return { kind: "error", message: `Unknown overview "${name}"` };
  const shown = languages === null ? snapshots : snapshots.map((snapshot) => ({ ...snapshot, counts: { ...snapshot.counts, languages } }));
  return { kind: "ready", bundle: shown.reduce(withOverview, bundle) };
}

/**
 * Owns the source's lifetime: it is created in an effect and disposed on cleanup, so StrictMode's
 * double init leaves no drip timer running for a discarded source.
 */
function Viewer({
  bundle,
  drip,
  hash,
  selftest,
  openProbe,
  barProbe,
  mapHeadProbe,
  approx,
  frame,
  chrome,
  view,
}: {
  bundle: TraceBundle;
  drip: DripOptions | undefined;
  hash: string;
  selftest: boolean;
  openProbe: boolean;
  barProbe: boolean;
  mapHeadProbe: boolean;
  approx: boolean;
  frame: number | undefined;
  chrome: "full" | "embedded";
  view: ViewKind | undefined;
}) {
  const [source, setSource] = useState<StaticBundleSource | null>(null);
  useEffect(() => {
    const created = createStaticBundleSource(
      bundle,
      selftest ? { drip: selftestDrip(bundle) } : drip === undefined ? undefined : { drip: resolveDrip(drip, bundle) },
    );
    setSource(created);
    return () => {
      created.dispose();
      setSource(null);
    };
  }, [bundle, drip, selftest]);
  if (source === null) return null;
  return (
    <ViewerBody
      source={source}
      bundle={bundle}
      drip={drip}
      hash={hash}
      selftest={selftest}
      openProbe={openProbe}
      barProbe={barProbe}
      mapHeadProbe={mapHeadProbe}
      approx={approx}
      frame={frame}
      chrome={chrome}
      view={view}
    />
  );
}

function ViewerBody({
  source,
  bundle,
  drip,
  hash,
  selftest,
  openProbe,
  barProbe,
  mapHeadProbe,
  approx,
  frame,
  chrome,
  view,
}: {
  source: StaticBundleSource;
  bundle: TraceBundle;
  drip: DripOptions | undefined;
  hash: string;
  selftest: boolean;
  openProbe: boolean;
  barProbe: boolean;
  mapHeadProbe: boolean;
  approx: boolean;
  frame: number | undefined;
  chrome: "full" | "embedded";
  view: ViewKind | undefined;
}) {
  const [result, setResult] = useState<SelftestResult | null>(null);
  const [test] = useState(() =>
    selftest ? createSelftest({ source, total: bundle.rows.length, write: setResult }) : null,
  );
  useEffect(() => {
    if (test === null) return undefined;
    test.start();
    return () => test.stop();
  }, [test]);
  const [opened, setOpened] = useState<OpenProbeResult | null>(null);
  const [probe] = useState(() =>
    openProbe
      ? createOpenProbe({ sessionId: bundle.session.sessionId, claimStepId: claimStepIdOf(bundle), write: setOpened })
      : null,
  );
  useEffect(() => {
    if (probe === null) return undefined;
    probe.start();
    return () => probe.stop();
  }, [probe]);
  const [bar, setBar] = useState<BarProbeResult | null>(null);
  const [barRun] = useState(() => (barProbe ? createBarProbe(setBar, { approx }) : null));
  useEffect(() => {
    if (barRun === null) return undefined;
    barRun.start();
    return () => barRun.stop();
  }, [barRun]);
  const [mapHead, setMapHead] = useState<MapHeadProbeResult | null>(null);
  const [mapHeadRun] = useState(() => (mapHeadProbe ? createMapHeadProbe(setMapHead) : null));
  useEffect(() => {
    if (mapHeadRun === null) return undefined;
    mapHeadRun.start();
    return () => mapHeadRun.stop();
  }, [mapHeadRun]);
  const location = useMemo(() => locationFromHash(hash, bundle.session.sessionId), [hash, bundle]);
  const showBrief = useMemo(() => new URLSearchParams(window.location.search).get("brief") === "1", []);
  const host = useMemo<ViewerHost>(
    () => ({
      onLocation: (next) => history.replaceState(null, "", locationToHash(next)),
      // ?brief=1 (screenshots only): Esc up to an empty selection, so the right panel shows the Brief (spec E4).
      ...(showBrief
        ? {
            onReady: () => {
              // After the open defaults select a step (spec §7.8): Esc collapses, goes to the parent, then clears.
              window.setTimeout(() => {
                for (let i = 0; i < 4; i += 1) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
              }, 300);
            },
          }
        : {}),
      ...(test === null ? {} : test.host),
    }),
    [test, showBrief],
  );
  const viewer = (
    <TraceViewer
      source={source}
      host={host}
      location={location}
      pollMs={selftest ? 100 : (drip?.intervalMs ?? 1_000)}
      initialFollow={selftest ? false : undefined}
      chrome={chrome}
      initialView={view}
    />
  );
  return (
    <>
      {chrome === "embedded" ? (
        <div className={styles.embedded} style={frame === undefined ? undefined : { right: "auto", width: frame }}>
          <div className={styles.embeddedBody}>{viewer}</div>
          {/* A stand-in for lane 03's prompt dock, so screenshots match the main-window mockup's frame. */}
          <div className={styles.embeddedDock} aria-hidden="true">
            <span className={styles.dockGlyph}>›</span>
            <span>Message the agent · Enter for a new line</span>
            <span>⌘↵ send</span>
          </div>
        </div>
      ) : (
        viewer
      )}
      {selftest ? (
        <pre id="selftest" className={styles.result}>
          {result === null ? "" : JSON.stringify(result)}
        </pre>
      ) : null}
      {openProbe ? (
        <pre id="selftest" className={styles.result}>
          {opened === null ? "" : JSON.stringify(opened)}
        </pre>
      ) : null}
      {barProbe ? (
        <pre id="selftest" className={styles.result}>
          {bar === null ? "" : JSON.stringify(bar)}
        </pre>
      ) : null}
      {mapHeadProbe ? (
        <pre id="selftest" className={styles.result}>
          {mapHead === null ? "" : JSON.stringify(mapHead)}
        </pre>
      ) : null}
    </>
  );
}

export function DevHost({ search, hash }: { search: string; hash: string }) {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const bundleName = params.get("bundle") ?? "oauth";
  const drip = useMemo(() => parseDrip(params.get("drip")), [params]);
  const perf = params.get("perf") === "1";
  const selftest = params.get("selftest") === "drip";
  const openProbe = params.get("selftest") === "open";
  const barProbe = params.get("selftest") === "bar";
  const mapHeadProbe = params.get("selftest") === "maphead";
  const gapRows = parseGaps(params.get("gaps"));
  const approx = params.get("approx") === "1";
  const frame = parseFrame(params.get("frame"));
  const chrome = params.get("chrome") === "embedded" ? "embedded" : "full";
  const view = parseView(params.get("view"));
  const overviewName = params.get("overview");
  const languagesParam = params.get("languages");
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  // Each bundle request (a ?bundle= fetch or a drop) takes a token; only the latest may write.
  const requestToken = useRef(0);

  useEffect(() => {
    const token = (requestToken.current += 1);
    void loadBundle(bundleName)
      .then((next) =>
        next.kind === "ready" && overviewName !== null ? attachOverview(next.bundle, overviewName, parseLanguages(languagesParam)) : next,
      )
      .then((next) => {
        if (requestToken.current === token) setLoaded(next);
      });
    return () => {
      // A later token (a drop or a new bundle name) supersedes this fetch.
      if (requestToken.current === token) requestToken.current += 1;
    };
  }, [bundleName, overviewName, languagesParam]);

  const shownBundle = useMemo(() => {
    if (loaded.kind !== "ready" || (gapRows === 0 && !approx)) return null;
    const withGaps = withGapRows(loaded.bundle, gapRows);
    return approx ? withApproximateJoins(withGaps) : withGaps;
  }, [loaded, gapRows, approx]);

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file === undefined) return;
    const token = (requestToken.current += 1);
    if (file.size > MAX_DROPPED_BYTES) {
      setLoaded({ kind: "error", message: `File too large (max ${MAX_DROPPED_BYTES / 1024 / 1024} MiB)` });
      return;
    }
    file
      .text()
      .then((text) => {
        if (requestToken.current === token) setLoaded(parseBundleText(text));
      })
      .catch(() => {
        if (requestToken.current === token) setLoaded({ kind: "error", message: "Could not read the dropped file" });
      });
  };

  return (
    <div className={styles.host} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      {loaded.kind === "loading" ? <p className={styles.message}>{`Loading ${bundleName}`}</p> : null}
      {loaded.kind === "error" ? (
        <p className={styles.message} role="alert">
          {loaded.message}
        </p>
      ) : null}
      {loaded.kind === "ready" ? (
        <Viewer
          key={`${loaded.bundle.session.sessionId}:${loaded.bundle.exportedAt}`}
          bundle={shownBundle ?? loaded.bundle}
          drip={drip}
          hash={hash}
          selftest={selftest}
          openProbe={openProbe}
          barProbe={barProbe}
          mapHeadProbe={mapHeadProbe}
          approx={approx}
          frame={frame}
          chrome={chrome}
          view={view}
        />
      ) : null}
      {perf ? <PerfHud autorun={params.get("perfrun") === "1"} consoleRun={params.get("perfrun") === "console"} /> : null}
    </div>
  );
}
