import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  TRACE_ROWS_PAGE_MAX,
  TraceBundleSchema,
} from "@jevcode/contracts";
import type { TraceBundle, TraceRow, TraceRowsPage } from "@jevcode/contracts";

import { redactText } from "./pipeline/redactor.js";
import { clipTraceRow } from "./trace-service.js";
import type { TraceService } from "./trace-service.js";

export interface BuildTraceBundleOptions {
  homeDir?: string; // default os.homedir()
  now?: () => string; // default () => new Date().toISOString()
  pageSize?: number; // default TRACE_ROWS_PAGE_MAX
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches homeDir only where a path segment ends, so "/Users/ann" maps in
 * "/Users/ann/x" and "/Users/ann" but not in "/Users/anna/x" or "/Users/ann.bak".
 * Returns null for "" and "/", which would otherwise rewrite every path.
 */
function homePattern(homeDir: string): RegExp | null {
  const trimmed = homeDir.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return null;
  return new RegExp(`${escapeRegExp(trimmed)}(?![\\w.-])`, "g");
}

/**
 * Deep walk: every string passes redactText, then homeDir becomes "~".
 * count adds a string's redaction hits only when redaction changed it, so an
 * already-redacted marker such as "token=[REDACTED:token]" is not counted again.
 */
export function redactBundleValue(
  value: unknown,
  homeDir: string,
): { value: unknown; count: number } {
  const home = homePattern(homeDir);
  let count = 0;
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      const redacted = redactText(current);
      if (redacted.text !== current) count += redacted.count;
      return home === null ? redacted.text : redacted.text.replace(home, "~");
    }
    if (Array.isArray(current)) return current.map(walk);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]): [string, unknown] => [key, walk(entry)]),
      );
    }
    return current;
  };
  return { value: walk(value), count };
}

type JsonObject = Record<string, unknown>;
type Capper = (value: unknown) => unknown;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Truncates to `max` UTF-16 code units (the unit zod's `.max` counts) without leaving half a surrogate pair. */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

const str =
  (max: number): Capper =>
  (value) =>
    typeof value === "string" ? clipChars(value, max) : value;
const each =
  (inner: Capper): Capper =>
  (value) =>
    Array.isArray(value) ? value.map(inner) : value;
/** Applies a capper to each listed key that is present; absent keys stay absent and other keys pass through. */
const fields =
  (spec: Record<string, Capper>): Capper =>
  (value) => {
    if (!isJsonObject(value)) return value;
    const out: JsonObject = { ...value };
    for (const [key, cap] of Object.entries(spec)) {
      if (Object.hasOwn(value, key)) out[key] = cap(value[key]);
    }
    return out;
  };

// The max lengths of the free-text strings in packages/contracts/src/overview.ts (K-2). Regex-checked
// fields (component ids, contentHash) and enums are left out: no redaction rule matches inside
// `cmp_` + 12 hex or 40 hex, and truncation could not restore a pattern anyway.
const ID = str(128);
const PATH = str(1024);
const SENTENCE = fields({ text: str(220), citations: each(fields({ id: str(512) })) });

const capSnapshot = fields({
  sessionId: ID,
  repoRoot: PATH,
  scanId: ID,
  counts: fields({ languages: each(str(40)) }),
  status: fields({ scan: fields({ error: str(200) }) }),
  components: each(
    fields({
      rootPath: PATH,
      name: str(120),
      files: each(PATH),
      language: str(40),
      purpose: str(140),
      externalDeps: each(fields({ name: str(214) })),
      entryPoints: each(PATH),
    }),
  ),
  edges: each(fields({ examples: each(str(300)) })),
  externals: each(fields({ name: str(214) })),
  narrative: fields({ sentences: each(SENTENCE) }),
  generatedAt: str(64),
});

// One spec for the three record kinds: story (sentences), decision_why (decisionId, sentence) and
// highlights (components[].unitIds). Each kind carries only its own keys.
const capExplainer = fields({
  sessionId: ID,
  sentences: each(SENTENCE),
  decisionId: ID,
  sentence: SENTENCE,
  components: each(fields({ unitIds: each(ID) })),
});

/**
 * Redaction can lengthen a string ("token=ab" becomes "token=[REDACTED:token]"), which would push a
 * capped string of an overview_snapshot or explainer row over its K-2 schema limit and turn the row
 * into an `invalid_row` gap in the viewer. This truncates those strings back to the limits (ruling
 * F16). Truncating keeps the secret redacted. Other row types pass through unchanged.
 */
export function capRedactedRow(type: string, payload: unknown): unknown {
  if (type === "overview_snapshot") return capSnapshot(payload);
  if (type === "explainer") return capExplainer(payload);
  return payload;
}

/**
 * Pages the service to the end with clipping off, then per row: redactBundleValue
 * over the whole payload, capRedactedRow back to the schema limits, and only then
 * the service's 16 KiB head + tail clip (spec §5.7). A secret that straddles the 4 KiB head cut is redacted before the
 * cut exists. factId is kept as computed, before redaction. One unclipped page is
 * bounded by the reader's 2 MiB payload bound.
 */
export function buildTraceBundle(
  service: TraceService,
  sessionId: string,
  options: BuildTraceBundleOptions = {},
): TraceBundle {
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? (() => new Date().toISOString());
  const pageSize = options.pageSize ?? TRACE_ROWS_PAGE_MAX;
  const summary = service.session(sessionId);
  const rows: TraceRow[] = [];
  let redactionCount = 0;
  let afterSeq = 0;
  let page: TraceRowsPage;
  for (;;) {
    page = service.rows({ sessionId, afterSeq, limit: pageSize }, { clip: false });
    for (const row of page.rows) {
      // Envelope fields (seq, type, ts, factId) are machine values; factId
      // must stay the pre-redaction content id.
      if (!("payload" in row)) {
        rows.push(row);
        continue;
      }
      const payload = redactBundleValue(row.payload, homeDir);
      redactionCount += payload.count;
      rows.push(clipTraceRow({ ...row, payload: capRedactedRow(row.type, payload.value) }));
    }
    if (page.nextAfterSeq === null) break;
    afterSeq = page.nextAfterSeq;
  }
  // The summary is re-stamped from the last page so lastEventSeq and state
  // describe exactly the rows in this bundle.
  const session = redactBundleValue(
    { ...summary, lastEventSeq: page.lastSeq, state: page.state },
    homeDir,
  );
  redactionCount += session.count;
  return TraceBundleSchema.parse({
    format: TRACE_BUNDLE_FORMAT,
    version: TRACE_BUNDLE_VERSION,
    exportedAt: now(),
    redactionCount,
    session: session.value,
    rows,
  });
}

/** JSON + "\n", file mode 0o600. Rows are written one at a time, so a large session never becomes one giant string. */
export function writeTraceBundle(filePath: string, bundle: TraceBundle): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const { rows, ...head } = bundle;
  const headJson = JSON.stringify(head);
  const fd = openSync(filePath, "w", 0o600);
  try {
    writeSync(fd, `${headJson.slice(0, -1)},"rows":[`);
    rows.forEach((row, index) => {
      writeSync(fd, `${index === 0 ? "" : ","}${JSON.stringify(row)}`);
    });
    writeSync(fd, "]}\n");
  } finally {
    closeSync(fd);
  }
  // openSync's mode applies only when it creates the file.
  chmodSync(filePath, 0o600);
}
