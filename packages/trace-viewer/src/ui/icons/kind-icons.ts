import type { ChangeCategory, Role } from "@jevcode/contracts";

import type { Lane, SignalId, StepKind } from "../../model/index.js";
import type { IconName } from "./icon-names.js";

export const KIND_ICON = {
  instruction: "person", message: "bubble", reasoning: "thought", command: "term", test: "test",
  check: "gauge", edit: "edit", read: "eye", tool: "plug", approval: "key", decision: "fork",
  dependency: "pkg", revert: "undo", lifecycle: "flag", guardrail: "shield", attention: "jev",
} as const satisfies Record<StepKind, IconName>;

export const LANE_ICON = {
  supervisor: "person", agent: "bubble", commands: "term", edits: "edit", tests: "test", jev: "jev",
} as const satisfies Record<Lane, IconName>;

export const LANE_LABEL = {
  supervisor: "Supervisor", agent: "Agent", commands: "Commands", edits: "Edits", tests: "Tests", jev: "Jev",
} as const satisfies Record<Lane, string>;

export const CATEGORY_ICON = {
  schema: "table", tests: "test", dependency: "pkg", architecture: "route", api: "route", security: "shield",
  behavior: "list", configuration: "list", performance: "list", implementation: "list", documentation: "list",
} as const satisfies Record<ChangeCategory, IconName>;

export const SIGNAL_ICON = {
  claim_contradicted: "neq", failing_tests: "test", destructive_command: "term", guardrail_clamp: "shield", recovery_arc: "check",
} as const satisfies Record<SignalId, IconName>;

/** Map role icons (spec §3.6); tests reuse the test flask, external packages use `pkg`. */
export const ROLE_ICON: { readonly [K in Role]: IconName } = {
  ui: "role-ui",
  api: "role-api",
  agent: "role-agent",
  domain: "role-domain",
  storage: "role-storage",
  tests: "test",
  tooling: "role-tooling",
  config: "role-config",
};

export const ROLE_LABEL: { readonly [K in Role]: string } = {
  ui: "UI",
  api: "API",
  agent: "Agent",
  domain: "Domain",
  storage: "Storage",
  tests: "Tests",
  tooling: "Tooling",
  config: "Config",
};
