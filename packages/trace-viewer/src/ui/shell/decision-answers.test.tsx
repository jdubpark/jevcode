// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSION, type DecisionOption, type TraceBundle, type TraceRow } from "@jevcode/contracts";

import { createStaticBundleSource } from "../../sources/static-bundle.js";
import { TraceBuilder, testMeta } from "../../test-support/trace-builder.js";
import { stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import { createDecisionAnswerStore } from "./decision-answers.js";
import { TraceViewer } from "./TraceViewer.js";

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

const OPTIONS: DecisionOption[] = [
  { id: "open", label: "Fail open", description: "", tradeoffs: [{ dimension: "availability", consequence: "API stays up." }] },
  { id: "closed", label: "Fail closed", description: "" },
];

/** A live session waiting on decision d1; with `answered`, the row that answers it comes next. */
function rows(answered: boolean): TraceRow[] {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add a limiter" });
  b.agent({ type: "agent_message", role: "assistant", text: "Redis is a single point of failure." });
  b.decision({ id: "d1", status: "open", title: "Redis down?", options: OPTIONS });
  if (answered) b.decision({ id: "d1", status: "answered", title: "Redis down?", options: OPTIONS, answer: { decisionId: "d1", decision: { policy: "open" }, evidence: [] } });
  return b.rows;
}

function bundle(all: TraceRow[]): TraceBundle {
  return {
    format: TRACE_BUNDLE_FORMAT, version: TRACE_BUNDLE_VERSION, exportedAt: "2026-10-03T10:00:00.000Z", redactionCount: 0,
    session: testMeta({ state: "waiting_decision", lastEventSeq: all.length }), rows: all,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const card = () => within(screen.getByRole("region", { name: "Decision card: Redis down?" }));
const chooseButtons = () => card().getAllByRole("button", { name: /^Choose/ }) as HTMLButtonElement[];

describe("createDecisionAnswerStore", () => {
  it("sends once per decision while an answer is on its way or sent, never a blank option, and again after a failure", async () => {
    const store = createDecisionAnswerStore();
    const send = vi.fn(async () => undefined);
    expect(store.answer("d1", "  ", send)).toBeNull();
    const first = store.answer("d1", "open", send);
    expect(store.snapshot().get("d1")).toBe("sending");
    expect(store.answer("d1", "closed", send)).toBeNull();
    expect(await first).toBe("sent");
    expect(store.answer("d1", "closed", send)).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => {
      throw new Error("no");
    });
    expect(await store.answer("d2", "open", failing)).toBe("failed");
    expect(await store.answer("d2", "open", send)).toBe("sent");
    expect(store.snapshot().get("d2")).toBe("sent");
  });
});

describe("one answer store for the Console and the Brief (lane 07 S-4 fix I-1)", () => {
  it("an answer sent from the Console's decision block shows on the Brief's card, which sends nothing more", async () => {
    const sending = deferred();
    const answerDecision = vi.fn(() => sending.promise);
    const source = createStaticBundleSource(bundle(rows(false)));
    render(<TraceViewer source={source} host={{ answerDecision }} initialView="console" pollMs={50} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Decision card: Redis down?" })).toBeTruthy());
    const feed = screen.getByRole("feed", { name: "Console" });
    fireEvent.click(within(feed).getByRole("button", { name: "Fail open" }));
    expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d1", optionId: "open" });
    expect(card().getByText("Sending answer")).toBeTruthy();
    expect(chooseButtons().every((button) => button.disabled)).toBe(true);
    await act(async () => sending.resolve());
    expect(card().getByText("Answer sent")).toBeTruthy();
    fireEvent.click(card().getByRole("button", { name: "Choose Fail closed" }));
    expect(answerDecision).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it("an answer from the Brief survives the Brief unmounting for a selection, and no second answer goes out", async () => {
    const answerDecision = vi.fn(async () => undefined);
    const source = createStaticBundleSource(bundle(rows(false)));
    render(<TraceViewer source={source} host={{ answerDecision }} initialView="console" pollMs={50} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Decision card: Redis down?" })).toBeTruthy());
    fireEvent.click(card().getByRole("button", { name: "Choose Fail open" }));
    await waitFor(() => expect(card().getByText("Answer sent")).toBeTruthy());
    // The question selects the decision's step: the Inspector replaces (unmounts) the Brief.
    fireEvent.click(card().getByRole("button", { name: "Redis down?" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Decision card: Redis down?" })).toBeNull());
    // Esc steps out of the selection until the Brief is back.
    for (let i = 0; i < 4 && screen.queryByRole("region", { name: "Decision card: Redis down?" }) === null; i += 1) {
      fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    }
    await waitFor(() => expect(screen.getByRole("region", { name: "Decision card: Redis down?" })).toBeTruthy());
    expect(card().getByText("Answer sent")).toBeTruthy();
    expect(chooseButtons().every((button) => button.disabled)).toBe(true);
    fireEvent.click(card().getByRole("button", { name: "Choose Fail closed" }));
    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Could not send the answer. Try again.")).toBeNull();
    source.dispose();
  });
});

describe("focus when a card moves from open to decided (lane 07 S-4 fix I-2)", () => {
  it("Enter on Choose, then the answered row: focus lands on the decided card in the Brief", async () => {
    const user = userEvent.setup();
    const answerDecision = vi.fn(async () => undefined);
    const all = rows(true);
    const source = createStaticBundleSource(bundle(all), { drip: { rowsPerTick: 1, intervalMs: 1_000, manual: true, startAtSeq: all.length - 2 } });
    render(<TraceViewer source={source} host={{ answerDecision }} initialView="console" pollMs={50} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Decision card: Redis down?" })).toBeTruthy());
    const choose = card().getByRole("button", { name: "Choose Fail open" });
    act(() => choose.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(card().getByText("Answer sent")).toBeTruthy());
    act(() => source.tick());
    await waitFor(() => expect(card().getByText("Fail open · chosen by you")).toBeTruthy());
    const brief = document.querySelector<HTMLElement>("[data-brief]");
    expect(brief?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Decision card: Redis down?" }));
    expect(answerDecision).toHaveBeenCalledTimes(1);
    source.dispose();
  });
});
