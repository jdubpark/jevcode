import type { CitationUniverse, ComponentBrief } from "../narrator/types.js";

export const DESKTOP_ID = "cmp_0000000000d1";
export const STORAGE_ID = "cmp_0000000000d2";
export const VIEWER_ID = "cmp_0000000000d3";

export const SAMPLE_BRIEFS: ComponentBrief[] = [
  {
    id: DESKTOP_ID,
    name: "jevcode-desktop",
    rootPath: "apps/desktop",
    roleGuess: "ui",
    files: ["apps/desktop/src/main/index.ts", "apps/desktop/src/main/ipc.ts", "apps/desktop/src/renderer/App.tsx"],
    exports: [],
    externalDeps: ["electron", "react", "node-pty"],
    edgesIn: [],
    edgesOut: [
      { name: "@jevcode/storage", count: 41 },
      { name: "@jevcode/trace-viewer", count: 12 },
    ],
    blurb: null,
  },
  {
    id: STORAGE_ID,
    name: "@jevcode/storage",
    rootPath: "packages/storage",
    roleGuess: "storage",
    files: ["packages/storage/src/db.ts", "packages/storage/src/migrations.ts", "packages/storage/src/trace-reader.ts"],
    exports: ["openDb", "JevcodeDb", "openTraceReader"],
    externalDeps: ["better-sqlite3", "zod"],
    edgesIn: [{ name: "jevcode-desktop", count: 41 }],
    edgesOut: [],
    blurb: "SQLite event store for jevcode sessions.",
  },
  {
    id: VIEWER_ID,
    name: "@jevcode/trace-viewer",
    rootPath: "packages/trace-viewer",
    roleGuess: "ui",
    files: ["packages/trace-viewer/src/model/fold.ts", "packages/trace-viewer/src/ui/shell/TraceViewer.tsx"],
    exports: ["TraceViewer", "createTraceState", "finalize"],
    externalDeps: ["react"],
    edgesIn: [{ name: "jevcode-desktop", count: 12 }],
    edgesOut: [],
    blurb: null,
  },
];

export function universeFor(briefs: readonly ComponentBrief[]): CitationUniverse {
  return {
    components: new Set(briefs.map((brief) => brief.id)),
    files: new Set(briefs.flatMap((brief) => brief.files)),
    decisions: new Set(),
    facts: new Set(),
    steps: new Set(),
    componentNames: new Set(briefs.map((brief) => brief.name)),
    componentNameById: new Map(briefs.map((brief) => [brief.id, brief.name] as const)),
  };
}

/**
 * POST /v1/messages response bodies in the Messages API shape. The answer text was
 * written for this fixture; re-check it against a live run (narrator.live.test.ts)
 * when the prompts change.
 */
export const RECORDED_DESCRIBE_MESSAGE = {
  id: "msg_01NarratorDescribeFixture",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        components: [
          { key: "c1", purpose: "Electron app that opens the windows, routes IPC and runs the agent pipeline.", role: "api", cite: ["c1", "c1.f1", "c1.f2"] },
          { key: "c2", purpose: "SQLite event store with migrations and a read-only trace reader.", role: "storage", cite: ["c2", "c2.f1"] },
          { key: "c3", purpose: "React viewer that folds trace rows into a session model and draws its views.", role: "ui", cite: ["c3", "c3.f1"] },
        ],
      }),
    },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1184, output_tokens: 162 },
};

export const RECORDED_OVERVIEW_MESSAGE = {
  id: "msg_01NarratorOverviewFixture",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        sentences: [
          { text: "jevcode is a desktop app that shows what a coding agent does as a console, a map and a trace.", cite: ["c1"] },
          { text: "The Electron app stores every agent event in the SQLite event store and reads it back for the viewer.", cite: ["c1", "c2"] },
          { text: "The React trace viewer folds those rows into a session model and renders its views.", cite: ["c3", "c2"] },
          { text: "The stack is TypeScript, Electron, React and SQLite.", cite: ["c1", "c2", "c3"] },
        ],
      }),
    },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 642, output_tokens: 118 },
};
