import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { openTraceReader } from "@jevcode/storage";
import { foldRows } from "@jevcode/trace-viewer/model";
import type { TraceSession } from "@jevcode/trace-viewer/model";
import {
  createStaticBundleSource,
  parseTraceBundle,
  readAllTraceRows,
} from "@jevcode/trace-viewer/sources";
import type { LoadedTrace } from "@jevcode/trace-viewer/sources";
import { afterEach, describe, expect, it } from "vitest";

import { createIpcTraceSource } from "../renderer/trace/ipc-source.js";
import type { JevcodeApi } from "../shared/api.js";
import { parseToMain } from "../shared/ipc-registry.js";
import { runReplay } from "./replay/cli-entry.js";
import { redactBundleValue } from "./trace-bundle.js";
import { createTraceService } from "./trace-service.js";
import type { TraceService } from "./trace-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const FIXTURES = ["api-break", "dep-change", "oauth", "rate-limit", "schema-change"] as const;
/** Small pages force many trace:rows round trips through cursorAfter. */
const IPC_PAGE_SIZE = 7;
/** Spec §6.7: claim_contradicted is the top finding on these two fixtures. */
const CLAIM_FIXTURES = new Set(["oauth", "api-break"]);

const tempDirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-trace-parity-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * The trace window's view of main: requests pass the toMain zod schemas (as the
 * ipc.ts handle wrapper does), replies are structured-cloned (as IPC does), and
 * the session summary and every row payload pass the bundle's redaction, so both
 * folds see identical strings (spec §8.7).
 */
function bridgeOver(
  service: TraceService,
  homeDir: string,
): { bridge: JevcodeApi["trace"]; redactions: () => number } {
  let redactions = 0;
  const redact = <T>(value: T): T => {
    const result = redactBundleValue(value, homeDir);
    redactions += result.count;
    return result.value as T;
  };
  const redactRow = (row: TraceRow): TraceRow =>
    "payload" in row ? { ...row, payload: redact(row.payload) } : row;
  return {
    bridge: {
      listSessions: async (request = {}) =>
        structuredClone(
          service
            .listSessions(parseToMain("trace:listSessions", request))
            .map((summary): TraceSessionSummary => redact(summary)),
        ),
      rows: async (request) => {
        const page: TraceRowsPage = service.rows(parseToMain("trace:rows", request));
        return structuredClone({ ...page, rows: page.rows.map(redactRow) });
      },
      payloads: async (request) =>
        structuredClone(
          service
            .payloads(parseToMain("trace:payloads", { sessionId: request.sessionId, seqs: [...request.seqs] }))
            .map(redactRow),
        ),
      open: async () => {
        throw new Error("trace:open is a main-window channel");
      },
      requestChanges: async () => {
        throw new Error("the parity test never hands off a note");
      },
    },
    redactions: () => redactions,
  };
}

/** The DataController's final fold for a finished read (UI index §2.4). */
function foldLoaded(loaded: LoadedTrace): TraceSession {
  const page = loaded.lastPage;
  return foldRows(loaded.summary, loaded.rows, {
    live: false,
    state: page.state,
    throughSeq: page.nextAfterSeq ?? page.lastSeq,
  });
}

describe("trace parity: IPC source versus exported trace.json", () => {
  for (const fixture of FIXTURES) {
    it(
      `${fixture}: both paths fold to the same TraceSession`,
      async () => {
        const outDir = tempDir();
        const result = await runReplay(path.join(repoRoot, "fixtures", fixture), outDir);

        const reader = openTraceReader(path.join(outDir, "replay.db"));
        closers.push(() => reader.close());
        const { bridge, redactions } = bridgeOver(createTraceService(reader), os.homedir());
        const viaIpc = await readAllTraceRows(createIpcTraceSource(bridge, result.sessionId), {
          pageSize: IPC_PAGE_SIZE,
        });

        const parsed = parseTraceBundle(JSON.parse(readFileSync(result.bundlePath, "utf8")));
        if (!parsed.ok) throw new Error(`${fixture}: ${parsed.message}`);
        const viaBundle = await readAllTraceRows(createStaticBundleSource(parsed.bundle));

        expect(viaIpc.summary).toEqual(viaBundle.summary);
        expect(viaIpc.rows.map((row) => row.seq)).toEqual(viaBundle.rows.map((row) => row.seq));
        expect(viaIpc.rows).toEqual(viaBundle.rows);
        expect(redactions()).toBe(parsed.bundle.redactionCount);

        const ipcSession = foldLoaded(viaIpc);
        expect(ipcSession.steps.length).toBeGreaterThan(0);
        expect(ipcSession).toEqual(foldLoaded(viaBundle));
        if (CLAIM_FIXTURES.has(fixture)) {
          expect(ipcSession.findings.map((finding) => finding.ruleId)).toContain("claim_contradicted");
        }
      },
      120_000,
    );
  }
});
