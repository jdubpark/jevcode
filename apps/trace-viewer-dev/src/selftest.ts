import type { TraceBundle } from "@jevcode/contracts";
import type { DripOptions, StaticBundleSource, ViewerHost } from "@jevcode/trace-viewer";

import { startCanvasDriftProbe, type CanvasDriftProbe } from "./selftest-canvas.js";

export interface SelftestResult {
  ready: boolean;
  view: "hybrid" | "canvas";
  selectedTitle: string | null;
  errors: string[];
  cspViolations: string[];
  maxDriftPx: number;
  rows: number;
}

function textOf(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/** oauth's claim row, found by content; the drip start (deviation 8) and the open probe (deviation 10) share it. */
export function claimRowOf(bundle: TraceBundle): TraceBundle["rows"][number] | undefined {
  return bundle.rows.find((row) => row.type === "agent_event" && /all checks pass/i.test(textOf(row.payload)));
}

/** Review drip starting at oauth's claim row (found by content), so later rows still arrive (deviation 8). */
export function selftestDrip(bundle: TraceBundle): DripOptions {
  const lastSeq = bundle.rows.at(-1)?.seq ?? 0;
  const claim = claimRowOf(bundle);
  return { rowsPerTick: 5, intervalMs: 100, startAtSeq: claim?.seq ?? Math.max(1, lastSeq - 20) };
}

export interface Selftest {
  host: Pick<ViewerHost, "onReady" | "onDiagnostics">;
  start(): void;
  stop(): void;
}

/** The reader scrolls the shown view's feed (the spine, or the Console) to its middle: a wheel event first, so the view
 *  counts the scroll as the reader's and re-baselines its drift sample instead of reporting it (lane review I-3).
 *  Hidden views stay mounted under display: none, so the first feed in the document may not be the shown one. */
function scrollSpineToMiddle(): void {
  const feed = Array.from(document.querySelectorAll<HTMLElement>('[role="feed"]')).find((node) => node.getClientRects().length > 0);
  if (feed === undefined) return;
  feed.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true }));
  feed.scrollTop = Math.max(0, (feed.scrollHeight - feed.clientHeight) / 2);
}

export function createSelftest(options: {
  source: StaticBundleSource;
  total: number;
  view?: "hybrid" | "canvas";
  write(result: SelftestResult): void;
  settleMs?: number;
  timeoutMs?: number;
}): Selftest {
  const result: SelftestResult = {
    ready: false,
    view: options.view ?? "hybrid",
    selectedTitle: null,
    errors: [],
    cspViolations: [],
    maxDriftPx: 0,
    rows: 0,
  };
  const originalError = console.error;
  let timer: ReturnType<typeof setInterval> | null = null;
  let written = false;
  // C3-12: samples the Canvas frame nearest the viewport center; stays 0 while the Canvas is hidden.
  let canvasDrift: CanvasDriftProbe | null = null;

  const onError = (event: ErrorEvent): void => {
    result.errors.push(event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    result.errors.push(String(event.reason));
  };
  const onViolation = (event: SecurityPolicyViolationEvent): void => {
    result.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
  };
  const finish = (): void => {
    if (written) return;
    written = true;
    result.rows = options.source.released();
    if (canvasDrift !== null) {
      result.maxDriftPx = Math.max(result.maxDriftPx, canvasDrift.stop());
      canvasDrift = null;
    }
    options.write({ ...result, errors: [...result.errors], cspViolations: [...result.cspViolations] });
  };

  return {
    host: {
      onReady: () => {
        result.ready = true;
        requestAnimationFrame(scrollSpineToMiddle);
        canvasDrift ??= startCanvasDriftProbe();
      },
      onDiagnostics: (diagnostics) => {
        result.selectedTitle = diagnostics.selectedTitle;
        result.maxDriftPx = Math.max(result.maxDriftPx, diagnostics.maxAnchorDriftPx);
        for (const error of diagnostics.errors) if (!result.errors.includes(error)) result.errors.push(error);
      },
    },
    start() {
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      document.addEventListener("securitypolicyviolation", onViolation);
      console.error = (...args: unknown[]) => {
        result.errors.push(args.map((arg) => String(arg)).join(" "));
        originalError.apply(console, args);
      };
      const started = Date.now();
      let doneAt: number | null = null;
      timer = setInterval(() => {
        if (doneAt === null && options.source.released() >= options.total) doneAt = Date.now();
        const settled = doneAt !== null && Date.now() - doneAt >= (options.settleMs ?? 800);
        if (settled || Date.now() - started >= (options.timeoutMs ?? 4_000)) {
          finish();
          if (timer !== null) clearInterval(timer);
          timer = null;
        }
      }, 100);
    },
    stop() {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("securitypolicyviolation", onViolation);
      console.error = originalError;
      if (timer !== null) clearInterval(timer);
      timer = null;
      canvasDrift?.stop();
      canvasDrift = null;
    },
  };
}
