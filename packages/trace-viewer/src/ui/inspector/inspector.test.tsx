// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { foldRows, KIND_META, type TraceSession } from "../../model/index.js";
import { TraceBuilder, testMeta } from "../../test-support/trace-builder.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import { FINDING_TITLE } from "./finding-copy.js";
import { Inspector } from "./Inspector.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

function claimStepId(): string {
  const session = foldFixture("oauth");
  const claim = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
  if (claim === undefined) throw new Error("oauth has no claim_contradicted finding");
  return claim.anchorStepId;
}

function evidenceStepId(): `step:${number}` {
  const claim = foldFixture("oauth").findings.find((finding) => finding.ruleId === "claim_contradicted");
  const id = claim?.evidenceStepIds?.[0];
  if (id === undefined) throw new Error("oauth's claim has no evidence step");
  return id as `step:${number}`;
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const node = heading.closest("section");
  if (node === null) throw new Error(`no section for ${name}`);
  return node;
}

function inspectorText(): string {
  return document.querySelector('[role="tabpanel"]')?.textContent ?? "";
}

function titleSlot(): string {
  return document.querySelector('[data-slot="title"]')?.textContent ?? "";
}

function selectedTab(): string {
  return screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ?? "";
}

describe("Inspector", () => {
  it("opens on Summary with the finding-first title", () => {
    renderHarness(<Inspector host={{}} />, foldFixture("oauth"), { state: { selection: claimStepId() as `step:${number}` } });
    expect(selectedTab()).toBe("Summary");
    expect(titleSlot()).toBe(FINDING_TITLE.claim_contradicted);
    expect(screen.getAllByText(/all checks pass/).length).toBeGreaterThan(0);
  });

  it("resets Raw to Summary on a new selection while Evidence persists", () => {
    const session = foldFixture("oauth");
    const [a, b, c] = session.steps;
    const h = renderHarness(<Inspector host={{}} />, session, { state: { selection: a?.id ?? null } });
    act(() => h.store.dispatch({ type: "inspector/tab", tab: "raw" }));
    expect(selectedTab()).toBe("Raw");
    act(() => h.store.dispatch({ type: "select", id: b?.id ?? null, by: "shell" }));
    expect(selectedTab()).toBe("Summary");
    act(() => h.store.dispatch({ type: "inspector/tab", tab: "evidence" }));
    act(() => h.store.dispatch({ type: "select", id: c?.id ?? null, by: "shell" }));
    expect(selectedTab()).toBe("Evidence");
  });

  it("shows Request changes only when the host provides it and disables it with no selection", async () => {
    const session = foldFixture("oauth");
    renderHarness(<Inspector host={{}} />, session);
    expect(screen.getByRole("button", { name: /Copy review note/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /Request changes/ })).toBeNull();
    cleanup();

    const requestChanges = vi.fn();
    const h = renderHarness(<Inspector host={{ requestChanges }} />, session);
    const button = screen.getByRole("button", { name: /Request changes/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    const selected = claimStepId() as `step:${number}`;
    act(() => h.store.dispatch({ type: "select", id: selected, by: "shell" }));
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    await waitFor(() => expect(requestChanges).toHaveBeenCalledTimes(1));
    const request = requestChanges.mock.calls[0]?.[0] as { sessionId: string; selected: string; text: string };
    expect(request.sessionId).toBe(session.meta.sessionId);
    expect(request.selected).toBe(selected);
    expect(request.text.startsWith(`Re: trace ${session.meta.sessionId} +0:43 "Claim contradicts tests"`)).toBe(true);
    expect(request.text.includes("\n")).toBe(false);
  });

  it("announces a rejected requestChanges without an unhandled rejection", async () => {
    const requestChanges = vi.fn(async () => {
      throw new Error("INVALID_PAYLOAD");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const h = renderHarness(<Inspector host={{ requestChanges }} />, foldFixture("oauth"), {
      state: { selection: claimStepId() as `step:${number}` },
    });
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    await waitFor(() => expect(h.announcements).toContain("Could not send to the composer"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(h.announcements).not.toContain("Sent to the composer");
  });

  it("ignores repeat clicks while a request is in flight", async () => {
    let release: () => void = () => undefined;
    const requestChanges = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const h = renderHarness(<Inspector host={{ requestChanges }} />, foldFixture("oauth"), {
      state: { selection: claimStepId() as `step:${number}` },
    });
    const button = screen.getByRole("button", { name: /Request changes/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(requestChanges).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(h.announcements).toContain("Sent to the composer"));
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    expect(requestChanges).toHaveBeenCalledTimes(2);
  });

  it("keeps keyboard focus inside the inspector after a Related click changes the selection", () => {
    const h = renderHarness(<Inspector host={{}} />, foldFixture("oauth"), {
      state: { selection: claimStepId() as `step:${number}` },
    });
    const related = screen.getByText("Related").closest("section")?.querySelector("button");
    if (related === null || related === undefined) throw new Error("no Related button");
    related.focus();
    fireEvent.click(related);
    expect(h.store.get().selection).not.toBe(claimStepId());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.querySelector('[role="tabpanel"]')?.contains(document.activeElement)).toBe(true);
  });

  it("keeps focus on the request button while a send is in flight", async () => {
    let release: () => void = () => undefined;
    const requestChanges = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const h = renderHarness(<Inspector host={{ requestChanges }} />, foldFixture("oauth"), {
      state: { selection: claimStepId() as `step:${number}` },
    });
    const button = screen.getByRole("button", { name: /Request changes/ });
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    release();
    await waitFor(() => expect(h.announcements).toContain("Sent to the composer"));
    expect(document.activeElement).toBe(button);
  });

  it("drops the focus intent of a Related click that does not change the selection", () => {
    const h = renderHarness(<Inspector host={{}} />, foldFixture("oauth"), { state: { selection: claimStepId() as `step:${number}` } });
    const related = screen.getByText("Related").closest("section")?.querySelector("button");
    if (related === null || related === undefined) throw new Error("no Related button");
    const before = h.store.get().selection;
    let requested: string | null = null;
    const dispatch = vi.spyOn(h.store, "dispatch").mockImplementation((action) => {
      if (action.type === "select") requested = action.id;
    });
    related.focus();
    fireEvent.click(related);
    dispatch.mockRestore();
    expect(requested).not.toBeNull();
    expect(h.store.get().selection).toBe(before);
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => h.store.dispatch({ type: "select", id: requested as `step:${number}`, by: "shell" }));
    expect(document.activeElement).toBe(document.body);
  });

  it("does not move focus when the selection changes from outside the inspector", () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Inspector host={{}} />, session, { state: { selection: session.steps[0]?.id ?? null } });
    act(() => h.store.dispatch({ type: "select", id: session.steps[1]?.id ?? null, by: "shell" }));
    expect(document.activeElement).toBe(document.body);
  });

  it("moves between tabs with Home and End", () => {
    renderHarness(<Inspector host={{}} />, foldFixture("oauth"));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Summary" }), { key: "End" });
    expect(selectedTab()).toBe("Raw");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Raw" }), { key: "Home" });
    expect(selectedTab()).toBe("Summary");
  });

  it("copies the review note when the host has no requestChanges", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const h = renderHarness(<Inspector host={{}} />, foldFixture("oauth"), {
      state: { selection: claimStepId() as `step:${number}` },
    });
    fireEvent.click(screen.getByRole("button", { name: /Copy review note/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0]).startsWith("Re: trace ")).toBe(true);
    await waitFor(() => expect(h.announcements).toContain("Review note copied"));
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("agent text never fills the title slot", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Do the task" });
    b.agent({ type: "agent_message", role: "assistant", text: "Claim contradicts tests <img src=x onerror=alert(1)>" });
    b.agent({ type: "agent_completed" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const message = session.steps.find((step) => step.kind === "message");
    renderHarness(<Inspector host={{}} />, session, { state: { selection: message?.id ?? null } });
    expect(titleSlot()).toBe(KIND_META.message.label);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("Claim contradicts tests <img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("shows the claim evidence-first: the failing test, the evidence rows, and the claim text once", () => {
    renderHarness(<Inspector host={{}} />, foldFixture("oauth"), { state: { selection: claimStepId() as `step:${number}` } });
    const failing = section("Failing test");
    expect(failing.textContent).toContain("links a Google identity to an existing account by email");
    expect(failing.textContent).toContain("expected null to be 7");
    expect(failing.textContent).toContain("tests/auth/oauth.test.ts");
    const evidence = section("Evidence");
    expect(evidence.textContent).toContain("pnpm test");
    expect(evidence.textContent).toContain("exit 1");
    expect(evidence.textContent).toContain("14/15");
    expect(inspectorText().split("all checks pass").length - 1).toBe(1);
    expect(inspectorText()).not.toContain("Claim contradicted by evidence");
  });

  it("titles the cited test step by its own finding and lists the claim under Related", () => {
    renderHarness(<Inspector host={{}} />, foldFixture("oauth"), { state: { selection: evidenceStepId() } });
    expect(titleSlot()).toBe(FINDING_TITLE.failing_tests);
    expect(inspectorText()).not.toContain("all checks pass");
    const related = section("Related");
    expect([...related.querySelectorAll("button")].some((row) => row.textContent?.includes(FINDING_TITLE.claim_contradicted))).toBe(true);
  });

  it("caps Related at four rows plus a count, even for a step in thousands of chapters", () => {
    const base = foldFixture("oauth");
    const template = base.chapters[0];
    if (template === undefined) throw new Error("oauth has no chapters");
    const extra = Array.from({ length: 5_000 }, (_, i) => ({ ...template, id: `unit:many-${i}` as typeof template.id, title: `Chapter ${i}` }));
    const target = evidenceStepId();
    const session: TraceSession = {
      ...base,
      chapters: [...base.chapters, ...extra],
      steps: base.steps.map((step) => (step.id === target ? { ...step, chapterIds: extra.map((chapter) => chapter.id) } : step)),
    };
    renderHarness(<Inspector host={{}} />, session, { state: { selection: target } });
    const related = section("Related");
    const rows = [...related.querySelectorAll("button")].filter((button) => !/more/.test(button.textContent ?? ""));
    expect(rows.length).toBe(4);
    expect(related.textContent).toMatch(/4,?997 more/);
  });

  it("renders a bidi override in Summary text, the regroup note and the title as the escape token", () => {
    const base = foldFixture("oauth");
    const chapter = base.chapters[0];
    const decision = base.steps.find((step) => step.decision !== undefined);
    const failing = base.findings.find((finding) => finding.ruleId === "failing_tests");
    if (chapter === undefined || decision?.decision === undefined || failing === undefined) throw new Error("oauth shape changed");
    const hostile: TraceSession = {
      ...base,
      meta: { ...base.meta, prompt: "Add\u202Elogin" },
      chapters: base.chapters.map((item) => (item.id === chapter.id ? { ...item, title: "Changed src/\u202Etxt.exe" } : item)),
      findings: base.findings.map((finding) => (finding.id === failing.id ? { ...finding, reason: "pnpm\u202Etest still fails" } : finding)),
      steps: base.steps.map((step) =>
        step.id === decision.id && step.decision !== undefined
          ? { ...step, decision: { ...step.decision, options: step.decision.options.map((option) => ({ ...option, label: `opt\u202E${option.label}` })) } }
          : step,
      ),
    };
    const cases: Array<[string | null, string]> = [
      [null, "Add⟨U+202E⟩login"],
      [failing.anchorStepId, "pnpm⟨U+202E⟩test still fails"],
      [decision.id, "opt⟨U+202E⟩"],
    ];
    for (const [selection, token] of cases) {
      renderHarness(<Inspector host={{}} />, hostile, { state: { selection: selection as `step:${number}` | null } });
      const aside = document.body.textContent ?? "";
      expect(aside).toContain(token);
      expect(aside).not.toContain("\u202E");
      cleanup();
    }
    renderHarness(<Inspector host={{}} />, hostile, {
      state: { selection: chapter.id, selectionNote: { from: "unit:gone", to: chapter.id } },
    });
    expect(titleSlot()).toBe("Changed src/⟨U+202E⟩txt.exe");
    expect(screen.getByText("Regrouped into “Changed src/⟨U+202E⟩txt.exe”")).toBeTruthy();
    expect(document.body.textContent).not.toContain("\u202E");
  });

  it("summarizes findings as icon chips per signal and hides zero counts", () => {
    const session = foldFixture("oauth");
    renderHarness(<Inspector host={{}} />, session);
    const chips = screen.getAllByRole("button").filter((button) => button.hasAttribute("data-signal"));
    const bySignal = new Map<string, number>();
    for (const finding of session.findings) bySignal.set(finding.ruleId, (bySignal.get(finding.ruleId) ?? 0) + 1);
    expect(chips.map((chip) => chip.getAttribute("data-signal")).sort()).toEqual([...bySignal.keys()].sort());
    for (const chip of chips) expect(chip.textContent).toBe(String(bySignal.get(chip.getAttribute("data-signal") ?? "")));
    expect(inspectorText()).not.toMatch(/\b0 info\b/);
  });

  it("labels the Diff button with text", () => {
    const session = foldFixture("oauth");
    const edit = session.steps.find((step) => step.edit?.diffSeq !== undefined);
    renderHarness(<Inspector host={{}} />, session, { state: { selection: edit?.id ?? null } });
    expect(screen.getByRole("button", { name: "Diff" }).textContent).toBe("Diff");
  });

  it("summarizes the session when nothing is selected", () => {
    renderHarness(<Inspector host={{}} />, foldFixture("oauth"));
    expect(titleSlot()).toBe("Session");
    expect(screen.getByText(/of 5 signals active/)).toBeTruthy();
  });

  it("notes a regrouped selection", () => {
    const session = foldFixture("oauth");
    const chapter = session.chapters[0];
    renderHarness(<Inspector host={{}} />, session, {
      state: { selection: chapter?.id ?? null, selectionNote: { from: "unit:gone", to: chapter?.id ?? "unit:x" } },
    });
    expect(screen.getByText(`Regrouped into “${chapter?.title ?? ""}”`)).toBeTruthy();
  });
});
