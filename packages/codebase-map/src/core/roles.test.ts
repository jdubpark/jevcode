import type { ExternalDep, Role } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { componentIdFor, type ComponentDraft } from "./componentize.js";
import { guessRole, guessRoles } from "./roles.js";

function draft(rootPath: string, name: string, files: string[] = [`${rootPath}/index.ts`]): ComponentDraft {
  return {
    id: componentIdFor(rootPath),
    rootPath,
    name,
    files,
    language: "TypeScript",
    contentHash: "0".repeat(40),
    entryPoints: [],
    importsAnalyzed: true,
  };
}

const uses = (target: ComponentDraft, names: readonly string[]): ExternalDep[] =>
  names.map((name) => ({ name, usedBy: [{ componentId: target.id, count: 1 }] }));

const CASES: [string, ComponentDraft, readonly string[], Role][] = [
  ["a ui token in the path", draft("packages/ui-kit", "@x/ui-kit"), [], "ui"],
  ["no match inside a longer word", draft("packages/guide", "guide"), [], "domain"],
  ["react imports", draft("packages/screens", "screens"), ["react"], "ui"],
  ["vue imports", draft("packages/screens", "screens"), ["vue"], "ui"],
  ["an api token in the path", draft("src/routes", "routes"), [], "api"],
  ["electron imports", draft("apps/desktop/src/main", "desktop/main"), ["electron"], "api"],
  ["express imports", draft("packages/gateway", "gateway"), ["express"], "api"],
  ["an agent token in the name", draft("packages/agent-codex", "@x/agent-codex"), [], "agent"],
  ["router in the name", draft("packages/jev-router", "@x/jev-router"), [], "agent"],
  ["an LLM SDK import", draft("packages/brain", "brain"), ["@anthropic-ai/sdk"], "agent"],
  ["an LLM SDK by scope", draft("packages/brain", "brain"), ["@ai-sdk/openai"], "agent"],
  ["node-pty imports", draft("packages/term", "term"), ["node-pty"], "agent"],
  ["a storage token in the name", draft("packages/storage", "@x/storage"), [], "storage"],
  ["db in the name", draft("packages/db", "@x/db"), [], "storage"],
  ["better-sqlite3 imports", draft("packages/persist", "persist"), ["better-sqlite3"], "storage"],
  ["only test files", draft("tests", "tests", ["tests/test_a.py", "tests/b.test.ts"]), [], "tests"],
  ["scripts", draft("scripts", "scripts", ["scripts/release.mjs"]), [], "tooling"],
  [".github", draft(".github", ".github", [".github/workflows/ci.yml"]), [], "tooling"],
  ["the repo-root config component", draft(".", "config", ["package.json", "README.md"]), [], "config"],
  ["config files only", draft("configs", "configs", ["configs/vite.config.ts", "configs/tsconfig.base.json"]), [], "config"],
  ["first match wins: ui before agent", draft("packages/agent-ui", "@x/agent-ui"), [], "ui"],
  ["first match wins: api before storage", draft("packages/db-server", "@x/db-server"), [], "api"],
  ["agent words count only in the name", draft("agent/core", "core"), [], "domain"],
  ["anything else", draft("packages/model", "@x/model"), ["zod"], "domain"],
];

describe("guessRole (spec §5.4)", () => {
  it.each(CASES)("%s", (_label, target, imports, expected) => {
    expect(guessRole(target, uses(target, imports))).toBe(expected);
  });

  it("ignores packages that only other components import", () => {
    const target = draft("packages/model", "@x/model");
    const other = draft("packages/web", "@x/web");
    expect(guessRole(target, uses(other, ["react", "better-sqlite3"]))).toBe("domain");
  });

  it("guessRoles gives every draft its guessRole over the same externals", () => {
    const drafts = CASES.map(([, target]) => target);
    const externals = CASES.flatMap(([, target, imports]) => uses(target, imports));
    expect(guessRoles(drafts, externals)).toEqual(new Map(drafts.map((target) => [target.id, guessRole(target, externals)])));
  });
});
