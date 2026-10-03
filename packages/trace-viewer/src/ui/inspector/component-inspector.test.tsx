// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithViewer } from "../../test-support/canvas-view-harness.js";
import { componentId, overviewSnapshot } from "../../test-support/overview-builder.js";
import { buildSession } from "../../test-support/session-builder.js";
import type { ViewState } from "../state/view-state.js";
import { Inspector } from "./Inspector.js";

afterEach(() => cleanup());

const MAIN = "apps/desktop/src/main";
const snapshot = overviewSnapshot({
  components: [
    {
      rootPath: MAIN,
      name: "desktop main",
      role: "api",
      roleGuess: "ui",
      purpose: "Electron main process: IPC handlers and the event pipeline.",
      provenance: "model",
      files: Array.from({ length: 25 }, (_, i) => `${MAIN}/f${String(i).padStart(2, "0")}.ts`),
      fileCount: 61,
      externalDeps: [{ name: "node-pty", count: 2 }, { name: "electron", count: 9 }],
    },
    { rootPath: "packages/contracts", name: "contracts", role: "domain" },
    { rootPath: "apps/desktop/src/renderer", name: "desktop renderer", role: "ui" },
  ],
  edges: [
    { from: MAIN, to: "packages/contracts", count: 22, examples: [`${MAIN}/ipc.ts → packages/contracts/src/index.ts`] },
    { from: "apps/desktop/src/renderer", to: MAIN, count: 2 },
  ],
  narrative: {
    provenance: "model",
    sentences: [
      { text: "The main process feeds the pipeline.", citations: [{ kind: "component", id: componentId(MAIN) }] },
      { text: "Contracts holds the schemas.", citations: [{ kind: "component", id: componentId("packages/contracts") }] },
    ],
  },
});
const session = buildSession({
  steps: [
    { kind: "instruction", tMs: 0, text: "Add the explainer stage" },
    { kind: "edit", tMs: 1_000, target: `${MAIN}/pipeline/explainer-stage.ts`, edit: { added: 120, removed: 4 } },
    { kind: "edit", tMs: 2_000, target: "packages/contracts/src/overview.ts", edit: { added: 40, removed: 0 } },
  ],
  overview: snapshot,
});

function renderInspector(state: Partial<ViewState>) {
  return renderWithViewer(<Inspector host={{}} />, { session, state });
}

function panel(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-component-inspector="${id}"]`);
  if (element === null) throw new Error(`no component inspector for ${id}`);
  return element;
}

function part(root: HTMLElement, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return element;
}

describe("ComponentInspector (spec §3.4)", () => {
  it("shows role, provenance, purpose, files, imports, packages, session changes and citations", () => {
    renderInspector({ view: "map", mapSelection: componentId(MAIN) });
    const root = panel(componentId(MAIN));
    const inside = within(root);
    expect(inside.getByRole("heading", { level: 2, name: "desktop main" })).toBeTruthy();
    expect(inside.getByText("API · described by model")).toBeTruthy();
    expect(inside.getByText("· guessed UI")).toBeTruthy();
    expect(inside.getByText("Electron main process: IPC handlers and the event pipeline.")).toBeTruthy();
    expect(root.querySelectorAll("[data-component-file]")).toHaveLength(20);
    expect(inside.getByText("41 more")).toBeTruthy();
    const out = within(part(root, "[data-imports='out']"));
    expect(out.getByText("contracts")).toBeTruthy();
    expect(out.getByText("22")).toBeTruthy();
    expect(out.getByText(`${MAIN}/ipc.ts → packages/contracts/src/index.ts`)).toBeTruthy();
    const into = within(part(root, "[data-imports='in']"));
    expect(into.getByText("desktop renderer")).toBeTruthy();
    expect(into.getByText("2")).toBeTruthy();
    expect([...root.querySelectorAll("[data-component-package]")].map((row) => row.textContent)).toEqual(["electron9", "node-pty2"]);
    const changes = root.querySelectorAll("[data-component-change]");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.textContent).toContain("explainer-stage.ts");
    expect(inside.getByText("The main process feeds the pipeline.")).toBeTruthy();
    expect(inside.queryByText("Contracts holds the schemas.")).toBeNull();
  });

  it("scales a 4 px bar by each row's share of the largest count in its list, up to 48 px", () => {
    renderInspector({ view: "map", mapSelection: componentId(MAIN) });
    const root = panel(componentId(MAIN));
    const widths = (selector: string): string[] => [...root.querySelectorAll<HTMLElement>(`${selector} [data-list-bar]`)].map((bar) => bar.style.width);
    expect(widths("[data-imports='out']")).toEqual(["48px"]);
    expect(widths("[data-imports='in']")).toEqual(["48px"]);
    // electron 9 is the largest, node-pty 2 is round(48 · 2 ÷ 9) = 11.
    expect(widths("[data-component-package]")).toEqual(["48px", "11px"]);
  });

  it("a session change opens its step and leaves the component", async () => {
    const user = userEvent.setup();
    const { store } = renderInspector({ view: "map", mapSelection: componentId(MAIN) });
    await user.click(part(panel(componentId(MAIN)), "[data-component-change]"));
    expect(store.get().mapSelection).toBeNull();
    expect(store.get().selection).toBe(session.steps.find((step) => step.edit?.path === `${MAIN}/pipeline/explainer-stage.ts`)?.id);
  });

  it("a rule-based component without a purpose says so quietly", () => {
    renderInspector({ view: "map", mapSelection: componentId("packages/contracts") });
    expect(screen.getByText("No description yet")).toBeTruthy();
    expect(screen.getByText("Domain · rule-based")).toBeTruthy();
  });

  it("ignores the map selection outside the Map view", () => {
    renderInspector({ view: "hybrid", mapSelection: componentId(MAIN) });
    expect(document.querySelector("[data-component-inspector]")).toBeNull();
  });

  it("a component missing from the latest snapshot shows a quiet note", () => {
    renderInspector({ view: "map", mapSelection: "cmp_000000000000" });
    expect(screen.getByText("This component is no longer in the map.")).toBeTruthy();
  });

  it("lists the top 5 imports each way, then how many more", () => {
    const hub = "packages/hub";
    const targets = Array.from({ length: 8 }, (_, n) => `packages/t${n}`);
    const many = overviewSnapshot({
      components: [{ rootPath: hub, name: "hub", role: "domain" }, ...targets.map((rootPath) => ({ rootPath, role: "domain" as const }))],
      edges: targets.map((to, n) => ({ from: hub, to, count: 20 - n })),
    });
    renderWithViewer(<Inspector host={{}} />, { session: buildSession({ steps: [{ kind: "instruction", tMs: 0, text: "Map" }], overview: many }), state: { view: "map", mapSelection: componentId(hub) } });
    const out = part(panel(componentId(hub)), "[data-imports='out']");
    expect(within(out).getByText("Imports out · 8")).toBeTruthy();
    // By count: t0 (20) to t4 (16) show, t5 to t7 sit behind "3 more".
    expect([...out.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["t020", "t119", "t218", "t317", "t416"]);
    expect(within(out).getByText("3 more")).toBeTruthy();
    expect(part(panel(componentId(hub)), "[data-imports='in']").textContent).not.toContain("more");
  });

  it("names file rows and session changes by their full path; the visible text may be shortened", () => {
    renderInspector({ view: "map", mapSelection: componentId(MAIN) });
    const root = panel(componentId(MAIN));
    const file = root.querySelector("[data-component-file]");
    expect(file?.getAttribute("aria-label")).toBe(`${MAIN}/f00.ts`);
    const change = root.querySelector("[data-component-change]");
    expect(change?.getAttribute("aria-label")).toBe(`${MAIN}/pipeline/explainer-stage.ts, 120 lines added, 4 removed`);
    expect(change?.textContent).not.toContain(MAIN);
  });
});
