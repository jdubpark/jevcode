import { describe, expect, it } from "vitest";

import { buildOverviewModel } from "../model/index.js";
import { componentId, overviewSnapshot } from "../test-support/overview-builder.js";
import { buildSession } from "../test-support/session-builder.js";
import { componentDetails, fileBarPercent, LIST_BAR_MAX_PX, listBarPx, topPackages } from "./map-details.js";

const MAIN = "apps/desktop/src/main";
const snapshot = overviewSnapshot({
  components: [
    {
      rootPath: MAIN,
      role: "api",
      files: Array.from({ length: 25 }, (_, i) => `${MAIN}/f${String(i).padStart(2, "0")}.ts`),
      fileCount: 61,
      externalDeps: [{ name: "node-pty", count: 2 }, { name: "electron", count: 9 }],
    },
    { rootPath: "packages/contracts", name: "contracts", role: "domain" },
    { rootPath: "apps/desktop/src/renderer", name: "renderer", role: "ui" },
    { rootPath: "tools/py", name: "py", role: "tooling", language: "Python", importsAnalyzed: false },
  ],
  edges: [
    { from: MAIN, to: "packages/contracts", count: 22, examples: [`${MAIN}/ipc.ts → packages/contracts/src/index.ts`] },
    { from: "apps/desktop/src/renderer", to: MAIN, count: 2 },
    { from: "apps/desktop/src/renderer", to: "packages/contracts", count: 5 },
  ],
  narrative: {
    provenance: "model",
    sentences: [
      { text: "Main feeds the pipeline.", citations: [{ kind: "component", id: componentId(MAIN) }] },
      { text: "A main file matters.", citations: [{ kind: "file", id: `${MAIN}/f03.ts` }] },
      { text: "Contracts holds the schemas.", citations: [{ kind: "component", id: componentId("packages/contracts") }] },
    ],
  },
});
const overview = buildOverviewModel(snapshot, 1);
const session = buildSession({
  steps: [
    { kind: "edit", tMs: 1_000, target: `${MAIN}/pipeline/explainer-stage.ts`, edit: { added: 120, removed: 4 } },
    { kind: "edit", tMs: 2_000, target: "packages/contracts/src/overview.ts", edit: { added: 40, removed: 0 } },
  ],
  overview: snapshot,
});

describe("componentDetails (spec §3.4 Inspector)", () => {
  it("lists the top 20 files and how many more, imports both ways by count, packages, session changes and citations", () => {
    const details = componentDetails(overview, componentId(MAIN), session);
    expect(details?.files.shown).toHaveLength(20);
    expect(details?.files.more).toBe(41);
    expect(details?.importsOut).toEqual([
      { id: componentId("packages/contracts"), name: "contracts", count: 22, example: `${MAIN}/ipc.ts → packages/contracts/src/index.ts` },
    ]);
    expect(details?.importsIn).toEqual([{ id: componentId("apps/desktop/src/renderer"), name: "renderer", count: 2, example: null }]);
    expect(details?.externals).toEqual([{ name: "electron", count: 9 }, { name: "node-pty", count: 2 }]);
    expect(details?.changes.map((change) => change.path)).toEqual([`${MAIN}/pipeline/explainer-stage.ts`]);
    expect(details?.changes[0]?.stepId).toBe(session.steps[0]?.id);
    expect(details?.citations.map((sentence) => sentence.text)).toEqual(["Main feeds the pipeline.", "A main file matters."]);
  });

  it("returns null for a component the snapshot does not have", () => {
    expect(componentDetails(overview, "cmp_000000000000", session)).toBeNull();
  });
});

describe("bar scales (revised Map mockup)", () => {
  it("sizes the file-count bar by the square root of files over the largest count, at least 8%", () => {
    expect([fileBarPercent(61, 61), fileBarPercent(25, 100), fileBarPercent(64, 100), fileBarPercent(1, 61), fileBarPercent(0, 61), fileBarPercent(1, 10_000)]).toEqual([
      100, 50, 80, 13, 8, 8,
    ]);
    expect(fileBarPercent(5, 0)).toBe(8);
  });

  it("sizes a list bar by its share of the list's largest count, up to 48 px, at least 1 px for a nonzero count", () => {
    expect(LIST_BAR_MAX_PX).toBe(48);
    expect([listBarPx(22, 22), listBarPx(2, 9), listBarPx(1, 1_000), listBarPx(0, 5), listBarPx(5, 0)]).toEqual([48, 11, 1, 0, 0]);
  });

  it("picks a card's top packages by count, then name", () => {
    const component = overview.componentById.get(componentId(MAIN));
    if (component === undefined) throw new Error("no component");
    expect(topPackages(component, 1)).toEqual([{ name: "electron", count: 9 }]);
    expect(topPackages(component, 2).map((ext) => ext.name)).toEqual(["electron", "node-pty"]);
    expect(topPackages(component, 0)).toEqual([]);
  });
});
