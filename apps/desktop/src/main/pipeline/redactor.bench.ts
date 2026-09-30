import { createHash } from "node:crypto";

import { bench, describe } from "vitest";

import { prepareDiffForStorage } from "./redactor.js";

// Spec §12 M1b exit: the desktop prepareDiff takes <= 10 ms per call (the
// "mean" column, in ms) on a 2 MiB lockfile-style diff and on a 32 KiB source
// diff. soak.mjs runs with `evidence: false`, so only this bench times it.

const MIB = 1024 * 1024;

// A new pnpm-lock.yaml as one added hunk of package entries: 2,097,312 bytes.
function lockfileDiff(minBytes: number): string {
  const header = [
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "--- a/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
  ];
  const body: string[] = [];
  let bytes = 0;
  for (let index = 0; bytes < minBytes; index += 1) {
    const integrity = createHash("sha512").update(`pkg-${index}`).digest("base64");
    const entry = [
      `+  /pkg-${index}@1.${index % 50}.${index % 7}:`,
      `+    resolution: {integrity: sha512-${integrity}}`,
      "+    engines: {node: '>=18'}",
      "+    dev: false",
      "+",
    ];
    body.push(...entry);
    bytes += Buffer.byteLength(entry.join("\n")) + 1;
  }
  return [...header, `@@ -0,0 +1,${body.length} @@`, ...body, ""].join("\n");
}

// An edit of a TypeScript file in hunks of 3 context, 2 removed and 3 added
// lines: 32,938 bytes, so the 32 KiB cap drops its last hunk.
function sourceDiff(minBytes: number): string {
  const lines = [
    "diff --git a/src/server/routes.ts b/src/server/routes.ts",
    "--- a/src/server/routes.ts",
    "+++ b/src/server/routes.ts",
  ];
  for (let hunk = 0; Buffer.byteLength(lines.join("\n")) < minBytes; hunk += 1) {
    const at = 1 + hunk * 20;
    lines.push(
      `@@ -${at},8 +${at},9 @@ export function route${hunk}(app: App): void {`,
      `   const handler${hunk} = createHandler("/api/v1/items/${hunk}");`,
      `   app.use(logger({ level: "info", route: "items-${hunk}" }));`,
      `   const limit = Number(process.env.PAGE_SIZE ?? 50);`,
      `-  app.get("/api/v1/items/${hunk}", handler${hunk});`,
      `-  app.post("/api/v1/items/${hunk}", validate(schema${hunk}), handler${hunk});`,
      `+  app.get("/api/v1/items/${hunk}", cache({ ttlSeconds: 30 }), handler${hunk});`,
      `+  app.post("/api/v1/items/${hunk}", validate(schema${hunk}), audit("items"), handler${hunk});`,
      `+  app.delete("/api/v1/items/${hunk}/:id", requireRole("admin"), handler${hunk});`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const LOCKFILE = lockfileDiff(2 * MIB);
const SOURCE = sourceDiff(32 * 1024);

describe("prepareDiffForStorage", () => {
  bench("lockfile diff 2 MiB", () => {
    prepareDiffForStorage("pnpm-lock.yaml", LOCKFILE);
  });

  bench("source diff 32 KiB", () => {
    prepareDiffForStorage("src/server/routes.ts", SOURCE);
  });
});
