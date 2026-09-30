import { useEffect, useMemo, useState, type DragEvent } from "react";

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
} from "@jevcode/trace-viewer";

import styles from "./host.module.css";
import { PerfHud } from "./perf-hud.js";
import { createSelftest, selftestDrip, type SelftestResult } from "./selftest.js";
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

function Viewer({
  bundle,
  drip,
  hash,
  selftest,
  openProbe,
}: {
  bundle: TraceBundle;
  drip: DripOptions | undefined;
  hash: string;
  selftest: boolean;
  openProbe: boolean;
}) {
  const [source] = useState<StaticBundleSource>(() =>
    createStaticBundleSource(
      bundle,
      selftest ? { drip: selftestDrip(bundle) } : drip === undefined ? undefined : { drip: resolveDrip(drip, bundle) },
    ),
  );
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
  const location = useMemo(() => locationFromHash(hash, bundle.session.sessionId), [hash, bundle]);
  const host = useMemo<ViewerHost>(
    () => ({
      onLocation: (next) => history.replaceState(null, "", locationToHash(next)),
      ...(test === null ? {} : test.host),
    }),
    [test],
  );
  return (
    <>
      <TraceViewer
        source={source}
        host={host}
        location={location}
        pollMs={selftest ? 100 : (drip?.intervalMs ?? 1_000)}
        initialFollow={selftest ? false : undefined}
      />
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
    </>
  );
}

export function DevHost({ search, hash }: { search: string; hash: string }) {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const bundleName = params.get("bundle") ?? "oauth";
  const drip = parseDrip(params.get("drip"));
  const perf = params.get("perf") === "1";
  const selftest = params.get("selftest") === "drip";
  const openProbe = params.get("selftest") === "open";
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadBundle(bundleName).then((next) => {
      if (!cancelled) setLoaded(next);
    });
    return () => {
      cancelled = true;
    };
  }, [bundleName]);

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file === undefined) return;
    if (file.size > MAX_DROPPED_BYTES) {
      setLoaded({ kind: "error", message: "Not a jevcode trace" });
      return;
    }
    file
      .text()
      .then((text) => setLoaded(parseBundleText(text)))
      .catch(() => setLoaded({ kind: "error", message: "Could not read the dropped file" }));
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
          bundle={loaded.bundle}
          drip={drip}
          hash={hash}
          selftest={selftest}
          openProbe={openProbe}
        />
      ) : null}
      {perf ? <PerfHud autorun={params.get("perfrun") === "1"} /> : null}
    </div>
  );
}
