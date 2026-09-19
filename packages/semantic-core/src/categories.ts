import type { ChangeCategory, SemanticEventKind } from "@jevcode/contracts";

export const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.(c|m)?(t|j)sx?$/;

export const SECURITY_PATH_RE =
  /(^|\/)(auth|session|oauth|token|credential|permissions?|access.?control)(\/|\.|-|$)|\.env|jwt/i;

export const SCHEMA_PATH_RE =
  /(^|\/)migrations?\/|\.(sql|prisma)$|(^|\/)schema\.(t|j)sx?$|(^|\/)prisma\//;

export const ROUTE_PATH_RE =
  /(^|\/)(routes?|api|controllers?|endpoints?)(\/|\.|-|$)/;

export const FORMATTING_CATEGORY: ChangeCategory = "implementation";

const EVENT_KIND_CATEGORY: Record<SemanticEventKind, ChangeCategory> = {
  architecture_change: "architecture",
  behavior_change: "behavior",
  api_change: "api",
  schema_change: "schema",
  dependency_change: "dependency",
  security_change: "security",
  decision_candidate: "configuration",
  failure: "tests",
  test_result: "tests",
  implementation_change: "implementation",
};

export interface CategoryInput {
  files: readonly string[];
  eventKinds: readonly SemanticEventKind[];
  hasDependencyEvidence: boolean;
  formattingOnly: boolean;
}

export function isTestPath(file: string): boolean {
  return TEST_PATH_RE.test(file);
}

export function isSecurityPath(file: string): boolean {
  return SECURITY_PATH_RE.test(file);
}

export function isSchemaPath(file: string): boolean {
  return SCHEMA_PATH_RE.test(file);
}

export function isRoutePath(file: string): boolean {
  return ROUTE_PATH_RE.test(file);
}

export function allTestPaths(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => isTestPath(file));
}

export function deterministicCategory(input: CategoryInput): ChangeCategory {
  if (allTestPaths(input.files)) return "tests";
  if (input.files.some((file) => isSecurityPath(file))) return "security";
  if (input.files.some((file) => isSchemaPath(file))) return "schema";
  if (input.files.some((file) => isRoutePath(file))) return "api";
  for (const kind of input.eventKinds) {
    return EVENT_KIND_CATEGORY[kind];
  }
  if (input.hasDependencyEvidence) return "dependency";
  if (input.formattingOnly) return "implementation";
  return "implementation";
}

export function categoryForEventKind(kind: SemanticEventKind): ChangeCategory {
  return EVENT_KIND_CATEGORY[kind];
}
