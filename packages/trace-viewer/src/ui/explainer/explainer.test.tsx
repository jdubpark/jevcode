// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionOption } from "@jevcode/contracts";

import { buildBriefDecisions } from "../../layout/brief-decisions.js";
import { foldRows, type StepId, type TraceSession } from "../../model/index.js";
import { sentence } from "../../test-support/explainer-fixtures.js";
import { componentOf, overviewSnapshot, type ComponentSeed } from "../../test-support/overview-builder.js";
import { TraceBuilder, testMeta } from "../../test-support/trace-builder.js";
import { renderHarness } from "../../test-support/ui-harness.js";
import { DecisionCard } from "./DecisionCard.js";
import { StoryBlock } from "./StoryBlock.js";
import { SummaryBlock } from "./SummaryBlock.js";

afterEach(cleanup);

const MIDDLEWARE_SEED: ComponentSeed = { rootPath: "src/middleware", files: ["src/middleware/rate-limiter.ts"], name: "middleware" };
const MIDDLEWARE = componentOf(MIDDLEWARE_SEED);
const OPTIONS: DecisionOption[] = [
  {
    id: "open", label: "Fail ‮open", description: "",
    tradeoffs: [{ dimension: "availability", consequence: "API stays up." }, { dimension: "abuse", consequence: "Limits stop." }],
  },
  { id: "closed", label: "Fail closed", description: "" },
];

type NarratorWord = "off" | "unavailable" | "pending" | "ready";

function scenario(answered: boolean, withWhy: boolean, narrator?: NarratorWord): { session: TraceSession; edit: StepId; note: StepId } {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add a limiter" });
  const note = b.agent({ type: "agent_message", role: "assistant", text: "Redis is a single point of failure." });
  const edit = b.agent({ type: "file_changed", path: "src/middleware/rate-limiter.ts" });
  b.unit({ id: "u1", files: ["src/middleware/rate-limiter.ts"] });
  b.overview(
    overviewSnapshot({
      components: [MIDDLEWARE_SEED],
      ...(narrator === undefined ? {} : { status: { scan: { state: "done", scanned: 1, total: 1 }, narrator } }),
    }),
  );
  b.decision({ id: "d1", status: "open", title: "Redis down?", affectedChangeUnits: ["u1"], options: OPTIONS });
  if (answered) {
    b.decision({ id: "d1", status: "answered", title: "Redis down?", affectedChangeUnits: ["u1"], options: OPTIONS, answer: { decisionId: "d1", decision: { policy: "closed" }, evidence: [] } });
  }
  if (withWhy) b.explainer({ kind: "decision_why", decisionId: "d1", sentence: sentence("Closing keeps limits on.", { kind: "step", id: `step:${note}` }) });
  return { session: foldRows(testMeta({ state: "running" }), b.rows, { live: true }), edit: `step:${edit}` as const, note: `step:${note}` as const };
}

function cardOf(session: TraceSession) {
  const card = buildBriefDecisions(session).find((candidate) => candidate.decisionId === "d1");
  if (card === undefined) throw new Error("no card");
  return card;
}

describe("StoryBlock and CitationChips", () => {
  it("renders narrator text as plain text with a visible bidi token and the full text in the tooltip", () => {
    const { session } = scenario(false, false);
    renderHarness(<StoryBlock sentences={[sentence("Wired ‮timil in.", { kind: "component", id: MIDDLEWARE.id })]} label="Now" />, session);
    const text = screen.getByText("Wired ⟨U+202E⟩timil in.");
    expect(text.getAttribute("title")).toBe("Wired ⟨U+202E⟩timil in.");
    expect(document.body.innerHTML).not.toContain("‮");
  });

  it("selects a cited step, switches to the Map for a component, and leaves an unknown citation inert", () => {
    const { session, edit } = scenario(false, false);
    const harness = renderHarness(
      <StoryBlock
        sentences={[sentence("Edited the limiter.", { kind: "step", id: edit }, { kind: "component", id: MIDDLEWARE.id }, { kind: "step", id: "step:999" })]}
        label="Now"
      />,
      session,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(harness.store.get().selection).toBe(edit);
    fireEvent.click(screen.getByRole("button", { name: "Open middleware" }));
    expect(harness.store.get().view).toBe("map");
    expect(harness.store.get().mapSelection).toBe(MIDDLEWARE.id);
    expect(screen.getByLabelText("step, not in this trace").tagName).toBe("SPAN");
  });

  it("renders a fact citation as plain text that does nothing", () => {
    const { session } = scenario(false, false);
    const harness = renderHarness(<StoryBlock sentences={[sentence("Tests pass.", { kind: "fact", id: "fact_1" })]} label="Now" />, session);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const chip = screen.getByLabelText("evidence, not in this trace");
    fireEvent.click(chip);
    expect(harness.store.get().selection).toBeNull();
    expect(harness.store.get().view).toBe("hybrid");
  });
});

describe("StoryBlock provenance", () => {
  it("labels a rule-based story quietly and leaves model text unlabeled", () => {
    const { session } = scenario(false, false);
    const line = sentence("Changed 1 file in server.", { kind: "component", id: MIDDLEWARE.id });
    const first = renderHarness(<StoryBlock sentences={[line]} label="Now" provenance="rule" />, session);
    expect(screen.getByText("rule-based")).toBeTruthy();
    first.result.unmount();
    renderHarness(<StoryBlock sentences={[line]} label="Now" provenance="model" />, session);
    expect(screen.queryByText("rule-based")).toBeNull();
  });
});

describe("DecisionCard", () => {
  it("shows the question, options with tradeoffs, and Choose buttons only when answering is possible", () => {
    const { session } = scenario(false, false);
    const card = cardOf(session);
    const onAnswer = vi.fn();
    const first = renderHarness(<DecisionCard card={card} onAnswer={onAnswer} />, session);
    const region = screen.getByRole("region", { name: "Decision card: Redis down?" });
    expect(within(region).getByText("Needs your decision")).toBeTruthy();
    expect(within(region).getByText("Fail ⟨U+202E⟩open")).toBeTruthy();
    expect(within(region).getByText("availability: API stays up. · +1")).toBeTruthy();
    expect(within(region).getByText("availability: API stays up. · +1").getAttribute("title")).toBe("availability: API stays up.\nabuse: Limits stop.");
    fireEvent.click(within(region).getByRole("button", { name: "Choose Fail ⟨U+202E⟩open" }));
    expect(onAnswer).toHaveBeenCalledWith("open");
    first.result.unmount();
    renderHarness(<DecisionCard card={card} />, session);
    expect(screen.queryByRole("button", { name: /^Choose/ })).toBeNull();
  });

  it("disables Choose while an answer is on its way and keeps it disabled once sent", () => {
    const { session } = scenario(false, false);
    const card = cardOf(session);
    const onAnswer = vi.fn();
    const sending = renderHarness(<DecisionCard card={card} onAnswer={onAnswer} answer="sending" />, session);
    const region = screen.getByRole("region", { name: "Decision card: Redis down?" });
    expect(within(region).getByText("Sending answer")).toBeTruthy();
    for (const button of within(region).getAllByRole("button", { name: /^Choose/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onAnswer).not.toHaveBeenCalled();
    sending.result.unmount();

    renderHarness(<DecisionCard card={card} onAnswer={onAnswer} answer="failed" />, session);
    expect(screen.getByText("Could not send the answer. Try again.")).toBeTruthy();
    expect(screen.getByText("Could not send the answer. Try again.").closest("[role=alert]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose Fail closed" }));
    expect(onAnswer).toHaveBeenCalledWith("closed");
  });

  it("never offers a blank option id as an answer", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Go" });
    b.decision({ id: "d1", status: "open", title: "Pick", options: [{ id: "  ", label: "Blank", description: "" }, { id: "keep", label: "Keep", description: "" }] });
    const session = foldRows(testMeta({ state: "running" }), b.rows, { live: true });
    const onAnswer = vi.fn();
    renderHarness(<DecisionCard card={cardOf(session)} onAnswer={onAnswer} />, session);
    expect(screen.getAllByRole("button", { name: /^Choose/ }).map((button) => button.getAttribute("aria-label"))).toEqual(["Choose Keep"]);
  });

  it("shows who chose what, the why with its chips, and the affected components", () => {
    const { session, note } = scenario(true, true);
    const harness = renderHarness(<DecisionCard card={cardOf(session)} />, session);
    const region = screen.getByRole("region", { name: "Decision card: Redis down?" });
    expect(within(region).getByText("Fail closed · chosen by you")).toBeTruthy();
    expect(within(region).queryByText("Needs your decision")).toBeNull();
    expect(within(region).getByText("Closing keeps limits on.")).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: /^Open Redis is a single/ }));
    expect(harness.store.get().selection).toBe(note);
    fireEvent.click(within(region).getByRole("button", { name: "middleware" }));
    expect(harness.store.get().view).toBe("map");
    expect(harness.store.get().mapSelection).toBe(MIDDLEWARE.id);
  });

  it("the question selects the decision's step", () => {
    const { session } = scenario(false, false);
    const card = cardOf(session);
    const harness = renderHarness(<DecisionCard card={card} />, session);
    fireEvent.click(screen.getByRole("button", { name: "Redis down?" }));
    expect(harness.store.get().selection).toBe(card.stepId);
  });

  // Ruling R3: without a why, the card says the narrator state in lane 06's quiet words. A snapshot without
  // `status` whose purposes are null reads as "pending" (overviewStatusOf's default).
  it.each([
    ["off" as const, "Descriptions off"],
    ["unavailable" as const, "Descriptions unavailable"],
    [undefined, "Descriptions pending"],
    ["ready" as const, "No explanation yet"],
  ])("narrator %s: an answered decision without a why says %j, quietly", (narrator, text) => {
    const { session } = scenario(true, false, narrator);
    renderHarness(<DecisionCard card={cardOf(session)} />, session);
    const note = screen.getByText(text);
    expect(note.closest("[role=alert]")).toBeNull();
    expect(screen.getByText("Fail closed · chosen by you")).toBeTruthy();
  });
});

describe("SummaryBlock", () => {
  it("renders a ◆ Summary region whose Brief button clears the selection", () => {
    const { session, edit } = scenario(false, false);
    const harness = renderHarness(<SummaryBlock sentences={[sentence("The agent added the limiter.", { kind: "step", id: edit })]} />, session, {
      state: { selection: edit },
    });
    const region = screen.getByRole("region", { name: "Session summary" });
    expect(within(region).getByText("◆")).toBeTruthy();
    expect(within(region).queryByText("rule-based")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Show the Brief" }));
    expect(harness.store.get().selection).toBeNull();
  });

  it("marks a rule-based summary next to its heading", () => {
    const { session, edit } = scenario(false, false);
    renderHarness(<SummaryBlock sentences={[sentence("Edited 1 file.", { kind: "step", id: edit })]} provenance="rule" />, session);
    const region = screen.getByRole("region", { name: "Session summary" });
    expect(within(region).getAllByText("rule-based")).toHaveLength(1);
  });
});
