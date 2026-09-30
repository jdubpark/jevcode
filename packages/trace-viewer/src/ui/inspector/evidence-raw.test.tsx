// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
