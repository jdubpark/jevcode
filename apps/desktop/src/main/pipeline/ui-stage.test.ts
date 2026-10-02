import type { EvidenceFact, UIIntent } from "@jevcode/contracts";
import { PipelineCoordinator } from "@jevcode/semantic-core";
import { describe, expect, it } from "vitest";

import { compileChangeUnitSurface, type UiStageContext } from "./ui-stage.js";

const SESSION = "sess_arch";
const REPO = "repo_arch";
const TS = "2026-10-02T10:00:00.000Z";

const hunk = (file: string): EvidenceFact => ({
  type: "git_hunk",
  repoId: REPO,
  sessionId: SESSION,
  file,
  added: 5,
  removed: 1,
  isFormattingOnly: false,
  isConfigOnly: false,
  isLockfile: false,
  ts: TS,
});

const DIAGRAM: UIIntent = {
  attention: "surface",
  subject: "architecture",
  representation: "diagram",
  density: "normal",
  confidence: 0.9,
  showEvidence: true,
  showCode: false,
  secondaryViews: [],
  renderMode: "autonomous",
};

describe("ArchitectureDelta edges (console-explainer M-7)", () => {
  it("keeps the import edge between two files of a change unit", () => {
    const coordinator = new PipelineCoordinator();
    coordinator.ingest(hunk("src/a.ts"));
    coordinator.ingest(hunk("src/b.ts"));
    coordinator.ingest({
      type: "symbol_delta",
      repoId: REPO,
      sessionId: SESSION,
      path: "src/a.ts",
      ts: TS,
      added: [
        { name: "b", kind: "import", signature: 'import { b } from "./b";', startLine: 1, endLine: 1 },
        { name: "run", kind: "function", signature: "function run()", startLine: 3, endLine: 5 },
      ],
      removed: [],
      modified: [],
    });
    coordinator.ingest({
      type: "symbol_delta",
      repoId: REPO,
      sessionId: SESSION,
      path: "src/b.ts",
      ts: TS,
      added: [{ name: "b", kind: "function", signature: "export function b()", startLine: 1, endLine: 2 }],
      removed: [],
      modified: [],
    });
    coordinator.flush();
    const snapshot = coordinator.snapshot();
    const unit = snapshot.units.find((u) => u.files.includes("src/a.ts") && u.files.includes("src/b.ts"));
    expect(unit).toBeDefined();
    // Precondition: the semantic graph holds the dependency under its own hashed ids.
    expect(
      snapshot.graphEdges.some((e) => e.type === "DEPENDS_ON" && e.from.startsWith("file_") && e.to.startsWith("file_")),
    ).toBe(true);

    const ctx: UiStageContext = {
      sessionId: SESSION,
      facts: [],
      validations: snapshot.validations,
      failures: snapshot.failures,
      decisions: snapshot.decisions,
      semanticEvents: snapshot.events,
      graphNodes: snapshot.graphNodes,
      graphEdges: snapshot.graphEdges,
      agentEvents: [],
      units: snapshot.units,
    };
    const spec = compileChangeUnitSurface(unit!, DIAGRAM, ctx);
    const element = Object.values(spec.elements).find((entry) => entry.type === "ArchitectureDelta");
    const props = element?.props as { nodes: { id: string }[]; edges: { from: string; to: string; label?: string }[] };
    expect(props.edges).toEqual([{ from: "file:src/a.ts", to: "file:src/b.ts", label: "DEPENDS_ON" }]);
    const ids = new Set(props.nodes.map((node) => node.id));
    for (const edge of props.edges) {
      expect(ids.has(edge.from) && ids.has(edge.to)).toBe(true);
    }
  });
});
