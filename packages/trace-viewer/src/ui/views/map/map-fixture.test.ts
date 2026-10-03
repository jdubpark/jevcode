import { describe, expect, it } from "vitest";

import { OVERVIEW_SNAPSHOT_MAX_BYTES } from "@jevcode/contracts";

import { layoutMap, mapHubIds, mapImporterCounts, type MapBand, type MapLevel } from "../../../layout/map-layout.js";
import { buildOverviewModel } from "../../../model/index.js";
import { expectNoCardCrossings, expectNoOverlaps } from "../../../test-support/map-checks.js";
import { loadOverviewFixture } from "../../../test-support/overview-fixture.js";
import { MAP_ICON_ONLY_K, planMapFit } from "./map-camera.js";
import { linkSentence } from "./map-text.js";

// Spec §12 "a fixture table test on this repo's own snapshot". Bands follow each component's role (spec E12); the
// viewports are the Shell's main column at 1440 px (216 + 280 px side panels) and 1000 px (200 + 248 px), less the
// title bar and the Map header.

const EXPECTED_BAND: Readonly<Record<string, MapBand>> = {
  "desktop renderer": "ui",
  "trace-viewer-dev": "ui",
  "trace-viewer ui": "ui",
  "ui-catalog": "ui",
  "ui-compiler": "ui",
  "desktop main": "api",
  "desktop shell": "api",
  "agent-codex": "agent",
  "agent-core": "agent",
  "jev-router": "agent",
  contracts: "domain",
  "semantic-core": "domain",
  "evidence-engine": "domain",
  "codebase-map": "domain",
  "trace-viewer model": "domain",
  "trace-viewer layout": "domain",
  "trace-viewer": "domain",
  telemetry: "domain",
  storage: "storage",
  evals: "side",
  scripts: "side",
  config: "side",
};
const REQUIRED = Object.keys(EXPECTED_BAND);

const snapshot = loadOverviewFixture("jevcode");
const overview = buildOverviewModel(snapshot, 1);
const nameOf = (id: string): string => overview.componentById.get(id)?.name ?? id;

describe("Map layout of this repository (fixture overview-jevcode.json)", () => {
  it("places every component in its role band", () => {
    const layout = layoutMap(overview, { level: "card" });
    const names = layout.cards.map((card) => nameOf(card.id));
    expect(names).toHaveLength(REQUIRED.length);
    expect(names).toEqual(expect.arrayContaining(REQUIRED));
    for (const card of layout.cards) expect(card.band, nameOf(card.id)).toBe(EXPECTED_BAND[nameOf(card.id)]);
  });

  it("orders the bands UI, API · IPC, agents, domain, storage, then the side band", () => {
    expect(layoutMap(overview, { level: "card" }).bands.map((band) => band.band)).toEqual(["ui", "api", "agent", "domain", "storage", "side"]);
  });

  it("has contracts as the most imported component, and as a hub", () => {
    const layout = layoutMap(overview, { level: "card" });
    const importers = [...mapImporterCounts(layout.edges)].sort((a, b) => b[1] - a[1]);
    expect(nameOf(importers[0]?.[0] ?? "")).toBe("contracts");
    // The mockup shows contracts imported by 13 of 21 components, so it is the one hub (threshold max(6, ceil(n / 4))).
    expect([...mapHubIds(layout.edges, layout.cards.length)].map(nameOf)).toContain("contracts");
  });

  it("lays out without overlaps or card crossings at every level", () => {
    for (const level of ["chip", "card", "detail"] as MapLevel[]) {
      const layout = layoutMap(overview, { level });
      expectNoOverlaps(layout);
      expectNoCardCrossings(layout);
    }
  });

  it("fits the 1440 px main column at the card level and the 1000 px column at the chip level, with names shown at both", () => {
    // The approved mockups: k about 0.77 on 944 px (full height) and about 0.52 on 552 px (full width).
    const wide = planMapFit(overview, { w: 944, h: 700 });
    expect(wide?.level).toBe("card");
    expect(wide?.camera.k).toBeGreaterThanOrEqual(0.7);
    const narrow = planMapFit(overview, { w: 552, h: 700 });
    expect(narrow?.level).toBe("chip");
    expect(narrow?.camera.k).toBeGreaterThanOrEqual(MAP_ICON_ONLY_K);
    expect(narrow?.camera.k).toBeLessThan(0.7);
  });

  it("has a narrative whose sentences spell out every component they cite", () => {
    const sentences = snapshot.narrative?.sentences ?? [];
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      const parts = linkSentence(sentence, overview);
      expect(parts.some((part) => "marker" in part), sentence.text).toBe(false);
      expect(parts.filter((part) => "componentId" in part)).toHaveLength(sentence.citations.length);
    }
  });

  it("has a rule-based twin with the same components, no purposes, no narrative and the narrator off", () => {
    const rule = loadOverviewFixture("jevcode-rule");
    expect(snapshot.status?.narrator).toBe("ready");
    expect(rule.status?.narrator).toBe("off");
    expect(rule.components.map((component) => [component.id, component.contentHash])).toEqual(
      snapshot.components.map((component) => [component.id, component.contentHash]),
    );
    expect(rule.components.every((component) => component.purpose === null && component.provenance === "rule")).toBe(true);
    expect(rule.narrative).toBeNull();
  });

  it("stays under the 512 KB snapshot cap", () => {
    for (const name of ["jevcode", "jevcode-rule"] as const) {
      expect(new TextEncoder().encode(JSON.stringify(loadOverviewFixture(name))).length).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
    }
  });
});
