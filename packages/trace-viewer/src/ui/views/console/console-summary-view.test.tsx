// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSION, type TraceBundle, type TraceRow } from "@jevcode/contracts";

import { createStaticBundleSource } from "../../../sources/static-bundle.js";
import { sentence } from "../../../test-support/explainer-fixtures.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import { stubLayout, type LayoutStub } from "../../../test-support/ui-harness.js";
import { TraceViewer } from "../../shell/TraceViewer.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ width: 1400, height: 900 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

function bundle(rows: TraceRow[]): TraceBundle {
  return {
    format: TRACE_BUNDLE_FORMAT, version: TRACE_BUNDLE_VERSION, exportedAt: "2026-10-02T10:00:00.000Z", redactionCount: 0,
    session: testMeta({ state: "running", lastEventSeq: rows.length }), rows,
  };
}

describe("Console summary rows (live)", () => {
  it("adds one ◆ Summary per story refresh and none for an unchanged or stale story, without moving focus", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add a limiter" });
    b.agent({ type: "agent_message", role: "assistant", text: "Reading the server." });
    const read = sentence("The agent read the server.", { kind: "step", id: "step:2" });
    const firstStory = b.explainer({ kind: "story", sentences: [read], basisSeq: 2 });
    b.agent({ type: "agent_message", role: "assistant", text: "Adding the middleware." });
    b.explainer({ kind: "story", sentences: [read], basisSeq: 4 });
    b.explainer({ kind: "story", sentences: [sentence("Stale story.", { kind: "step", id: "step:2" })], basisSeq: 1 });
    const lastStory = b.explainer({ kind: "story", sentences: [sentence("The agent added the middleware.", { kind: "step", id: "step:4" })], basisSeq: 6 });
    const source = createStaticBundleSource(bundle(b.rows), {
      drip: { rowsPerTick: 1, intervalMs: 1_000, manual: true, startAtSeq: firstStory - 1 },
    });
    render(<TraceViewer source={source} initialView="console" pollMs={50} initialFollow={false} />);
    await waitFor(() => expect(screen.getAllByRole("region", { name: "Session summary" })).toHaveLength(1));
    const focused = document.activeElement;
    for (let seq = firstStory + 1; seq <= lastStory; seq += 1) act(() => source.tick());
    await waitFor(() => expect(screen.getAllByRole("region", { name: "Session summary" })).toHaveLength(2));
    expect(screen.queryByText("Stale story.")).toBeNull();
    expect(document.activeElement).toBe(focused);
    // The summary rows sit where their story rows arrived.
    const feed = screen.getByRole("feed", { name: "Console" });
    const kinds = Array.from(feed.querySelectorAll("article")).map((article) => article.getAttribute("data-kind"));
    expect(kinds).toEqual(["instruction", "message", "summary", "message", "summary"]);
    expect(within(feed).getAllByRole("region", { name: "Session summary" }).at(-1)?.textContent).toContain("The agent added the middleware.");
    source.dispose();
  });
});
