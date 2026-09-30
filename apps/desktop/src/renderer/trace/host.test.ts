import { describe, expect, it, vi } from "vitest";

import type { JevcodeApi } from "../../shared/api.js";
import { createDesktopViewerHost, sessionIdFromSearch, traceConsoleLine } from "./host.js";

type Bridge = JevcodeApi["trace"];

function fakeBridge(): Pick<JevcodeApi, "trace"> & {
  requestChanges: ReturnType<typeof vi.fn<Bridge["requestChanges"]>>;
} {
  const requestChanges = vi.fn<Bridge["requestChanges"]>(async () => undefined);
  return {
    requestChanges,
    trace: {
      listSessions: vi.fn<Bridge["listSessions"]>(async () => []),
      rows: vi.fn<Bridge["rows"]>(async () => ({ rows: [], nextAfterSeq: null, lastSeq: 0, state: "running" })),
      payloads: vi.fn<Bridge["payloads"]>(async () => []),
      open: vi.fn<Bridge["open"]>(async () => undefined),
      requestChanges,
    },
  };
}

describe("createDesktopViewerHost", () => {
  it("logs TRACE_READY with the row count once", () => {
    const lines: string[] = [];
    const host = createDesktopViewerHost(fakeBridge(), (line) => lines.push(line));
    host.onReady?.({ rows: 12, loadedThroughSeq: 40 });
    host.onReady?.({ rows: 30, loadedThroughSeq: 80 });
    expect(lines).toEqual(["TRACE_READY 12"]);
  });

  it("hands the review note to main unchanged and surfaces a failure", async () => {
    const bridge = fakeBridge();
    const host = createDesktopViewerHost(bridge, () => undefined);
    const request = {
      sessionId: "sess_1",
      selected: "step:48" as const,
      text: 'Re: trace sess_1 +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)',
    };
    await host.requestChanges?.(request);
    expect(bridge.requestChanges).toHaveBeenCalledWith(request);
    bridge.requestChanges.mockRejectedValueOnce(new Error("no session with id sess_1"));
    await expect(host.requestChanges?.(request)).rejects.toThrow(/no session/);
  });

  it("keeps the location in memory (no onLocation sink)", () => {
    expect(createDesktopViewerHost(fakeBridge(), () => undefined).onLocation).toBeUndefined();
  });
});

describe("sessionIdFromSearch", () => {
  it("reads the session query that openTraceWindow sets", () => {
    expect(sessionIdFromSearch("?session=sess_1")).toBe("sess_1");
    expect(sessionIdFromSearch("?session=a%26b")).toBe("a&b");
    expect(sessionIdFromSearch("?session=%20")).toBeNull();
    expect(sessionIdFromSearch("")).toBeNull();
    expect(sessionIdFromSearch("?other=1")).toBeNull();
  });
});

describe("traceConsoleLine", () => {
  it("reports the full-load mark and tv: measures only", () => {
    expect(traceConsoleLine({ name: "tv:full-load", entryType: "mark", startTime: 812.4, duration: 0 })).toBe(
      "TRACE_LOADED 812",
    );
    expect(traceConsoleLine({ name: "tv:live-tick", entryType: "measure", startTime: 5, duration: 3.456 })).toBe(
      "TRACE_PERF tv:live-tick 3.46",
    );
    expect(traceConsoleLine({ name: "tv:first-paint", entryType: "mark", startTime: 90, duration: 0 })).toBeNull();
    expect(traceConsoleLine({ name: "react-render", entryType: "measure", startTime: 1, duration: 2 })).toBeNull();
  });
});
