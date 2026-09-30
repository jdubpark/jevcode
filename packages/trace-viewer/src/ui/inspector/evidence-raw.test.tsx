// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import type { Step, TraceSession } from "../../model/index.js";
import {
  fixtureTrace,
  foldFixture,
  payloadOf,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../test-support/ui-harness.js";
import { Evidence } from "./Evidence.js";
import { Inspector } from "./Inspector.js";
import { Raw } from "./Raw.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
});

function withStep(base: TraceSession, id: string, change: (step: Step) => Step): TraceSession {
  return { ...base, steps: base.steps.map((step) => (step.id === id ? change(step) : step)) };
}

function fixturePayloads(mark?: (row: TraceRow) => TraceRow) {
  const { rows } = fixtureTrace("oauth");
  return vi.fn(async (seqs: readonly number[]) =>
    rows.filter((row) => seqs.includes(row.seq)).map((row) => (mark === undefined ? row : mark(row))),
  );
}

describe("Evidence", () => {
  it("shows the withheld label and no CodeDiff for a secret path", () => {
    const base = foldFixture("oauth");
    const edit = base.steps.find((step) => step.edit !== undefined);
    const session = withStep(base, edit?.id ?? "", (step) =>
      step.edit === undefined ? step : { ...step, edit: { ...step.edit, diff: "withheld_secret" } },
    );
    renderHarness(<Evidence selection={edit?.id ?? null} />, session);
    expect(screen.getByText("Diff withheld: secret path")).toBeTruthy();
    expect(screen.queryByTestId("code-diff")).toBeNull();
  });

  it("renders a captured diff through CodeDiff with redaction and truncation labels", async () => {
    const base = foldFixture("oauth");
    const edit = base.steps.find((step) => step.edit !== undefined);
    const session = withStep(base, edit?.id ?? "", (step) =>
      step.edit === undefined ? step : { ...step, edit: { ...step.edit, diff: "truncated", diffSeq: 999 } },
    );
    const payloads = vi.fn(async () => [
      {
        seq: 999,
        type: "evidence_fact",
        ts: "2026-09-18T09:00:15.000Z",
        payload: {
          type: "git_hunk",
          file: edit?.edit?.path,
          diff: { hash: "0123456789abcdef", bytes: 420_000, text: "@@ -3,1 +3,2 @@\n a\n+b\n", truncated: true, redactions: 2 },
        },
      } satisfies TraceRow,
    ]);
    renderHarness(<Evidence selection={edit?.id ?? null} />, session, { payloads });
    await screen.findByTestId("code-diff");
    expect(payloads).toHaveBeenCalledWith([999]);
    expect(screen.getByText("2 secrets redacted")).toBeTruthy();
    expect(screen.getByText(/^Truncated at hunk boundary · showing 0 KB of 410 KB$/)).toBeTruthy();
  });

  it("counts the shown diff in UTF-8 bytes, not UTF-16 units", async () => {
    const base = foldFixture("oauth");
    const edit = base.steps.find((step) => step.edit !== undefined);
    const session = withStep(base, edit?.id ?? "", (step) =>
      step.edit === undefined ? step : { ...step, edit: { ...step.edit, diff: "truncated", diffSeq: 999 } },
    );
    // 1,000 three-byte characters: 1,000 UTF-16 units (1 KB), 3,000 UTF-8 bytes (3 KB).
    const text = `@@ -1,1 +1,1 @@\n+${"\u20ac".repeat(1000)}\n`;
    const payloads = vi.fn(async () => [
      {
        seq: 999,
        type: "evidence_fact",
        ts: "2026-09-18T09:00:15.000Z",
        payload: { type: "git_hunk", file: edit?.edit?.path, diff: { hash: "0123456789abcdef", bytes: 409_600, text, truncated: true, redactions: 0 } },
      } satisfies TraceRow,
    ]);
    renderHarness(<Evidence selection={edit?.id ?? null} />, session, { payloads });
    expect(await screen.findByText(/^Truncated at hunk boundary · showing 3 KB of 400 KB$/)).toBeTruthy();
  });

  it("shows decision option descriptions and marks the chosen option", async () => {
    const session = foldFixture("oauth");
    const step = session.steps.find((s) => s.decision !== undefined);
    const decision = step?.decision;
    const base = fixturePayloads();
    const payloads = vi.fn(async (seqs: readonly number[]) =>
      (await base(seqs)).map((row) =>
        row.type === "decision"
          ? {
              ...row,
              payload: {
                ...(row.payload as object),
                options: (decision?.options ?? []).map((o) => ({ id: o.id, label: o.label, description: `Because ${o.id} works` })),
              },
            }
          : row,
      ),
    );
    renderHarness(<Evidence selection={step?.id ?? null} />, session, { payloads });
    const first = decision?.options[0];
    expect(await screen.findByText(`Because ${first?.id} works`)).toBeTruthy();
    expect(payloads).toHaveBeenCalledWith(step?.seqs);
    expect(screen.getByText(/^Answer: /)).toBeTruthy();
  });

  it("falls back to the model options when the decision row does not parse", async () => {
    const session = foldFixture("oauth");
    const step = session.steps.find((s) => s.decision !== undefined);
    const payloads = vi.fn(async () => [
      { seq: step?.seqs[0] ?? 1, type: "decision", ts: "2026-09-18T09:00:15.000Z", payload: { options: "nope" } } satisfies TraceRow,
    ]);
    renderHarness(<Evidence selection={step?.id ?? null} />, session, { payloads });
    await waitFor(() => expect(payloads).toHaveBeenCalled());
    expect(await screen.findByText(step?.decision?.options[0]?.label ?? "")).toBeTruthy();
  });

  it("clips a decision's payload request to the latest 50 seqs", async () => {
    const base = foldFixture("oauth");
    const step = base.steps.find((s) => s.decision !== undefined);
    const last = step?.seqs[step.seqs.length - 1] ?? 1;
    const many = Array.from({ length: 60 }, (_, i) => last - 59 + i);
    const session = withStep(base, step?.id ?? "", (s) => ({ ...s, seqs: many }));
    const payloads = vi.fn(async () => [] as TraceRow[]);
    renderHarness(<Evidence selection={step?.id ?? null} />, session, { payloads });
    await waitFor(() => expect(payloads).toHaveBeenCalled());
    expect(payloads).toHaveBeenCalledWith(many.slice(-50));
  });

  it("a failed decision fetch shows Retry, and Retry loads the descriptions", async () => {
    const session = foldFixture("oauth");
    const step = session.steps.find((s) => s.decision !== undefined);
    const base = fixturePayloads();
    const payloads = vi
      .fn(async (seqs: readonly number[]) =>
        (await base(seqs)).map((row) =>
          row.type === "decision"
            ? { ...row, payload: { ...(row.payload as object), options: (step?.decision?.options ?? []).map((o) => ({ id: o.id, label: o.label, description: "Loaded description" })) } }
            : row,
        ),
      )
      .mockRejectedValueOnce(new Error("channel closed"));
    renderHarness(<Evidence selection={step?.id ?? null} />, session, { payloads });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect((await screen.findAllByText("Loaded description")).length).toBeGreaterThan(0);
    expect(payloads).toHaveBeenCalledTimes(2);
  });

  it("a chapter with two edits to one path renders one diff for it, fetched from the later step", async () => {
    const base = foldFixture("oauth");
    const chapter = base.chapters.find((c) => c.stepIds.length >= 2);
    const [a, b] = chapter?.stepIds ?? [];
    const template = base.steps.find((s) => s.edit !== undefined)?.edit;
    if (template === undefined || a === undefined || b === undefined) throw new Error("fixture lacks a two-step chapter");
    const edited = (diffSeq: number) => (step: Step): Step => ({ ...step, edit: { ...template, path: "src/same.ts", diff: "text", diffSeq } });
    const session = withStep(withStep(base, a, edited(901)), b, edited(902));
    const payloads = vi.fn(async (seqs: readonly number[]) =>
      seqs.map(
        (seq) =>
          ({
            seq,
            type: "evidence_fact",
            ts: "2026-09-18T09:00:15.000Z",
            payload: { type: "git_hunk", file: "src/same.ts", diff: { hash: "0123456789abcdef", bytes: 20, text: "@@ -1,1 +1,1 @@\n-a\n+b\n", truncated: false, redactions: 0 } },
          }) satisfies TraceRow,
      ),
    );
    renderHarness(<Evidence selection={chapter?.id ?? null} />, session, { payloads });
    await screen.findAllByTestId("code-diff");
    expect(screen.getAllByText("src/same.ts").filter((el) => el.tagName === "P")).toHaveLength(1);
    expect(payloads).toHaveBeenCalledWith([902]);
    expect(payloads).not.toHaveBeenCalledWith([901]);
  });

  it("caps a chapter's concurrent file fetches at 50 and says N more", async () => {
    const base = foldFixture("oauth");
    const chapter = base.chapters.find((c) => c.stepIds.length >= 1);
    const template = base.steps.find((s) => s.edit !== undefined)?.edit;
    const ids = chapter?.stepIds ?? [];
    if (template === undefined || chapter === undefined) throw new Error("fixture lacks a chapter");
    const steps: Step[] = Array.from({ length: 60 }, (_, i) => {
      const source = base.steps.find((s) => s.id === ids[0]) ?? (base.steps[0] as Step);
      return { ...source, id: `step:${5000 + i}` as Step["id"], edit: { ...template, path: `src/f${i}.ts`, diff: "text", diffSeq: 5000 + i } };
    });
    const session: TraceSession = {
      ...base,
      steps: [...base.steps.map((s) => (ids.includes(s.id) ? { ...s, edit: undefined } : s)), ...steps],
      chapters: base.chapters.map((c) => (c.id === chapter.id ? { ...c, stepIds: [...c.stepIds, ...steps.map((s) => s.id)] } : c)),
    };
    const payloads = vi.fn(async () => [] as TraceRow[]);
    renderHarness(<Evidence selection={chapter.id} />, session, { payloads });
    await waitFor(() => expect(payloads.mock.calls.length).toBeGreaterThan(0));
    expect(payloads.mock.calls.length).toBeLessThanOrEqual(50);
    expect(screen.getByText("10 more")).toBeTruthy();
  });

  it("shows the completion row's output with its clipping label", async () => {
    const session = foldFixture("oauth");
    const test = session.steps.find((step) => step.command?.command === "pnpm test");
    const payloads = fixturePayloads((row) =>
      row.type === "agent_event" && payloadOf(row).type === "command_completed" ? { ...row, clipped: true } : row,
    );
    renderHarness(<Evidence selection={test?.id ?? null} />, session, { payloads });
    await screen.findByText(/Tests\s+1 failed \| 14 passed \(15\)/);
    expect(screen.getByText("Clipped to head + tail (16 KiB)")).toBeTruthy();
  });

  it("a payload failure shows an inline Retry", async () => {
    const session = foldFixture("oauth");
    const test = session.steps.find((step) => step.command?.command === "pnpm test");
    const ok = fixturePayloads();
    const payloads = vi
      .fn(async (seqs: readonly number[]) => ok(seqs))
      .mockRejectedValueOnce(new Error("channel closed"));
    renderHarness(<Evidence selection={test?.id ?? null} />, session, { payloads });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText(/Tests\s+1 failed \| 14 passed \(15\)/);
    expect(payloads).toHaveBeenCalledTimes(2);
  });

  it("says so when the item has no evidence", () => {
    const session = foldFixture("oauth");
    const message = session.steps.find((step) => step.kind === "message");
    renderHarness(<Evidence selection={message?.id ?? null} />, session);
    expect(screen.getByText("No evidence for this item")).toBeTruthy();
  });
});

describe("Raw", () => {
  it("does not fetch rows while the Summary tab is shown", async () => {
    const session = foldFixture("oauth");
    const first = session.steps[0];
    const payloads = fixturePayloads();
    const h = renderHarness(<Inspector host={{}} />, session, { payloads, state: { selection: first?.id ?? null } });
    await Promise.resolve();
    expect(payloads).not.toHaveBeenCalled();
    act(() => h.store.dispatch({ type: "inspector/tab", tab: "raw" }));
    await waitFor(() => expect(payloads).toHaveBeenCalled());
  });

  it("an IPC error message is shown as plain sanitized text", async () => {
    const session = foldFixture("oauth");
    const first = session.steps[0];
    const payloads = vi.fn(async () => {
      throw new Error("boom\u202Eevil");
    });
    renderHarness(<Raw selection={first?.id ?? null} />, session, { payloads });
    const message = await screen.findByText(/Could not load rows: boom/);
    expect(message.textContent).not.toContain("\u202E");
  });

  it("fetches at most 50 seqs and shows N more", async () => {
    const base = foldFixture("oauth");
    const first = base.steps[0];
    const seqs = Array.from({ length: 60 }, (_, i) => i + 1);
    const session = withStep(base, first?.id ?? "", (step) => ({ ...step, seqs }));
    const payloads = fixturePayloads();
    renderHarness(<Raw selection={first?.id ?? null} />, session, { payloads });
    await waitFor(() => expect(payloads).toHaveBeenCalledTimes(1));
    expect(payloads.mock.calls[0]?.[0]).toEqual(seqs.slice(0, 50));
    expect(screen.getByText("10 more")).toBeTruthy();
  });

  it("labels a clipped row", async () => {
    const session = foldFixture("oauth");
    const first = session.steps[0];
    const payloads = fixturePayloads((row) => ({ ...row, clipped: true }));
    renderHarness(<Raw selection={first?.id ?? null} />, session, { payloads });
    expect((await screen.findAllByText(/Clipped to head \+ tail \(16 KiB\)/)).length).toBeGreaterThan(0);
  });
});
