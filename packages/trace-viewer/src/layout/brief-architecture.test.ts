import { describe, expect, it } from "vitest";

import { componentId, overviewSnapshot } from "../test-support/overview-builder.js";
import { buildSession, type StepSeed } from "../test-support/session-builder.js";
import { buildBrief } from "./brief.js";
import { briefArchitecture } from "./brief-architecture.js";
import { buildTraceIndex } from "./trace-index.js";

const snapshot = overviewSnapshot({
  components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/api", role: "api" }, { rootPath: "packages/db", role: "storage" }],
});
const steps: StepSeed[] = [
  { kind: "instruction", tMs: 0, text: "Fix the login" },
  { kind: "edit", tMs: 1_000, target: "packages/db/src/users.ts", edit: { added: 3, removed: 1 } },
  { kind: "edit", tMs: 2_000, target: "apps/web/src/Login.tsx", edit: { added: 10, removed: 2 } },
  { kind: "edit", tMs: 3_000, target: "packages/db/src/sessions.ts", edit: { added: 5, removed: 0 } },
  { kind: "edit", tMs: 4_000, target: "docs/notes.md", edit: { added: 1, removed: 0 } },
];

describe("briefArchitecture (spec §3.3 item 3, §8.4)", () => {
  it("is null until a snapshot row arrives", () => {
    expect(briefArchitecture(buildSession({ steps }))).toBeNull();
  });

  it("Review Focus 5: works from rule-based data when the narrative is null", () => {
    expect(briefArchitecture(buildSession({ steps, overview: snapshot }))).toEqual({
      overviewSentences: null,
      componentCount: 3,
      touched: [componentId("packages/db"), componentId("apps/web")],
      scanning: null,
    });
  });

  it('counts a nested file no component claims as touching "(other)" when there is one, never the root-level "." (lane 06 fix I-3)', () => {
    const withRoot = overviewSnapshot({
      components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: ".", name: "config", role: "config", files: ["package.json"] }],
    });
    // docs/notes.md is nested and unclaimed: it is not a repo-root file, so "config" stays untouched.
    expect(briefArchitecture(buildSession({ steps, overview: withRoot }))?.touched).toEqual([componentId("apps/web")]);
    const withOther = overviewSnapshot({
      components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "(other)", name: "other", role: "domain", files: ["packages/db/src/users.ts"] }],
    });
    // packages/db/src/sessions.ts is past "(other)"'s file list but still one of its groups' files.
    expect(briefArchitecture(buildSession({ steps, overview: withOther }))?.touched).toEqual([componentId("(other)"), componentId("apps/web")]);
  });

  it("carries the narrator's sentences when there are some", () => {
    const narrated = overviewSnapshot({
      components: [{ rootPath: "apps/web", role: "ui" }],
      narrative: { provenance: "model", sentences: [{ text: "A web app.", citations: [{ kind: "component", id: componentId("apps/web") }] }] },
    });
    expect(briefArchitecture(buildSession({ steps, overview: narrated }))?.overviewSentences?.map((sentence) => sentence.text)).toEqual(["A web app."]);
  });

  it("fills scanning while the scan runs (ruling R3)", () => {
    const running = overviewSnapshot({ components: [], status: { scan: { state: "running", scanned: 3_200, total: 9_800 }, narrator: "pending" } });
    expect(briefArchitecture(buildSession({ steps, overview: running }))?.scanning).toEqual({ done: 3_200, total: 9_800 });
  });

  it("is what buildBrief returns as its architecture part", () => {
    const session = buildSession({ steps, overview: snapshot });
    expect(buildBrief(session, buildTraceIndex(session)).architecture).toEqual(briefArchitecture(session));
    const without = buildSession({ steps });
    expect(buildBrief(without, buildTraceIndex(without)).architecture).toBeNull();
  });
});
