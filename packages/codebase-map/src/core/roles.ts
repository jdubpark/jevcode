import type { ExternalDep, Role } from "@jevcode/contracts";

import { CONFIG_COMPONENT_NAME, TOOLING_DIRS, type ComponentDraft } from "./componentize.js";
import { isConfigFile, isTestPath } from "./paths.js";

// Spec §5.4, first match wins. Words match whole tokens of the root path or name (split on
// anything that is not a letter or digit), so "packages/guide" never reads as "ui".
const UI_WORDS = ["renderer", "ui", "web", "components", "views"];
const UI_IMPORTS = ["react", "react-dom", "vue", "svelte"];
const API_WORDS = ["ipc", "api", "routes", "server", "handlers"];
const API_IMPORTS = ["express", "fastify", "hono", "electron"];
const AGENT_WORDS = ["agent", "adapter", "router", "llm"];
const AGENT_IMPORTS = ["@anthropic-ai/sdk", "openai", "ai", "cohere-ai", "ollama", "langchain", "node-pty"];
const AGENT_IMPORT_PREFIXES = ["@anthropic-ai/", "@ai-sdk/", "@langchain/", "@mistralai/", "@google/generative-ai"];
const STORAGE_WORDS = ["storage", "db", "store"];
const STORAGE_IMPORTS = ["better-sqlite3", "prisma", "@prisma/client", "drizzle-orm", "pg", "mongodb"];

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token !== ""));
}

function hasAny(set: ReadonlySet<string>, words: readonly string[]): boolean {
  return words.some((word) => set.has(word));
}

export function guessRole(draft: ComponentDraft, externals: readonly ExternalDep[]): Role {
  const imported = new Set(
    externals.filter((dep) => dep.usedBy.some((use) => use.componentId === draft.id)).map((dep) => dep.name),
  );
  return roleOf(draft, imported);
}

/** `guessRole` for every draft, reading `externals` once instead of once per draft. */
export function guessRoles(drafts: readonly ComponentDraft[], externals: readonly ExternalDep[]): Map<string, Role> {
  const importedBy = new Map<string, Set<string>>();
  for (const dep of externals) {
    for (const use of dep.usedBy) {
      const names = importedBy.get(use.componentId);
      if (names === undefined) importedBy.set(use.componentId, new Set([dep.name]));
      else names.add(dep.name);
    }
  }
  const none: ReadonlySet<string> = new Set();
  return new Map(drafts.map((draft) => [draft.id, roleOf(draft, importedBy.get(draft.id) ?? none)]));
}

function roleOf(draft: ComponentDraft, imported: ReadonlySet<string>): Role {
  const name = tokens(draft.name);
  const pathOrName = new Set([...tokens(draft.rootPath), ...name]);
  const imports = (names: readonly string[]): boolean => names.some((pkg) => imported.has(pkg));

  if (hasAny(pathOrName, UI_WORDS) || imports(UI_IMPORTS)) return "ui";
  if (hasAny(pathOrName, API_WORDS) || imports(API_IMPORTS)) return "api";
  if (
    hasAny(name, AGENT_WORDS) ||
    imports(AGENT_IMPORTS) ||
    [...imported].some((pkg) => AGENT_IMPORT_PREFIXES.some((prefix) => pkg.startsWith(prefix)))
  ) {
    return "agent";
  }
  if (hasAny(name, STORAGE_WORDS) || imports(STORAGE_IMPORTS)) return "storage";
  if (draft.files.length > 0 && draft.files.every(isTestPath)) return "tests";
  if (TOOLING_DIRS.includes(draft.rootPath.split("/")[0] ?? "")) return "tooling";
  if (
    (draft.rootPath === "." && draft.name === CONFIG_COMPONENT_NAME) ||
    (draft.files.length > 0 && draft.files.every(isConfigFile))
  ) {
    return "config";
  }
  return "domain";
}
