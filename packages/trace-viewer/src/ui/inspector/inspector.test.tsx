// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { foldRows, KIND_META } from "../../model/index.js";
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
