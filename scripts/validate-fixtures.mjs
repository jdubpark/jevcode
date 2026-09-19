import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AttentionDecisionSchema,
  UIIntentSchema,
  NormalizedAgentEventSchema,
  EvidenceFactSchema,
  SemanticEventSchema,
  DecisionSchema,
  ChangeCategorySchema,
  JsonRenderSpecSchema,
} from "../packages/contracts/dist/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(scriptDir, "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures");
const SCENARIOS = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"];

const CATALOG_COMPONENTS = new Set([
  "ChangeOverview",
  "BehaviorDelta",
  "ArchitectureDelta",
  "SchemaDelta",
  "CodeDiff",
  "Decision",
  "TestMatrix",
  "FailureAnalysis",
  "ExecutionTimeline",
  "Terminal",
  "DependencyDelta",
]);

const ACTION_ALLOWLIST = new Set([
  "answer_decision",
  "delegate_decision",
  "restore_previous_api_semantics",
  "inspect_call_sites",
  "show_exact_diff",
  "accept_changes",
  "request_changes",
  "continue_task",
  "open_terminal",
  "interrupt_agent",
  "pin_surface",
  "dismiss_surface",
]);

const CATEGORY_TO_REPRESENTATION = {
  schema_change: "table",
  architecture_change: "diagram",
  security_change: "diagram",
  dependency_change: "graph",
  decision_candidate: "decision",
  behavior_change: "before_after",
  api_change: "before_after",
  failure: "failure",
  test_result: "table",
  implementation_change: "summary",
};

const CATEGORY_TO_ROOT_COMPONENT = {
  schema_change: "SchemaDelta",
  architecture_change: "ArchitectureDelta",
  security_change: "ArchitectureDelta",
  dependency_change: "DependencyDelta",
  decision_candidate: "Decision",
  behavior_change: "BehaviorDelta",
  api_change: "BehaviorDelta",
  failure: "FailureAnalysis",
  test_result: "TestMatrix",
  implementation_change: "ChangeOverview",
};

let checkCount = 0;
let failCount = 0;

function check(label, ok, detail = "") {
  checkCount += 1;
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failCount += 1;
    console.log(`FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function zodIssues(result) {
  if (!result || result.success) return "";
  return result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    return { __parseError: err.message };
  }
}

function isPathLike(value) {
  return (
    typeof value === "string" &&
    (value.includes("/") || /\.[a-z0-9]+$/i.test(value))
  );
}

function expectedRenderMode(confidence) {
  if (confidence >= 0.9) return "autonomous";
  if (confidence >= 0.7) return "conservative";
  if (confidence >= 0.5) return "generic";
  return "suppressed";
}

function collectSpecActions(spec) {
  const actions = [];
  for (const element of Object.values(spec.elements ?? {})) {
    const props = element.props ?? {};
    if (Array.isArray(props.actions)) {
      for (const item of props.actions) {
        if (item && typeof item === "object" && typeof item.action === "string") {
          actions.push(item.action);
        }
      }
    }
  }
  return actions;
}

function validateScenario(scenario) {
  console.log(`\n== ${scenario} ==`);
  const dir = path.join(FIXTURES_DIR, scenario);
  const prefix = `[${scenario}]`;

  // 1. events.jsonl
  const eventsPath = path.join(dir, "events.jsonl");
  const eventPathSet = new Set();
  const eventSymbolSet = new Set();
  const evidenceRefIds = new Set();
  let recordCount = 0;
  if (!existsSync(eventsPath)) {
    check(`${prefix} events.jsonl exists`, false);
  } else {
    check(`${prefix} events.jsonl exists`, true);
    const lines = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim() !== "");
    let allValid = true;
    for (const [index, line] of lines.entries()) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        check(`${prefix} events.jsonl line ${index + 1} is valid JSON`, false, "unparseable");
        allValid = false;
        continue;
      }
      const matches = [];
      const schemaResults = [
        NormalizedAgentEventSchema.safeParse(record),
        EvidenceFactSchema.safeParse(record),
        SemanticEventSchema.safeParse(record),
        DecisionSchema.safeParse(record),
      ];
      for (const result of schemaResults) {
        if (result.success) {
          matches.push(result);
        }
      }
      if (matches.length === 0) {
        check(
          `${prefix} events.jsonl line ${index + 1} matches a contracts schema`,
          false,
          zodIssues(schemaResults.find((r) => !r.success)) || "no schema matched"
        );
        allValid = false;
        continue;
      }
      recordCount += 1;
      collectPathsAndSymbols(record, eventPathSet, eventSymbolSet);
      if (typeof record.id === "string" && record.id.length > 0) {
        evidenceRefIds.add(record.id);
      }
      for (const ref of record.evidence ?? []) {
        if (ref && typeof ref.id === "string" && ref.id.length > 0) {
          evidenceRefIds.add(ref.id);
        }
      }
    }
    check(`${prefix} all ${recordCount} event records schema-valid`, allValid);
    if (lines.length > 0 && recordCount === lines.length) {
      check(`${prefix} every event record validated (${recordCount} records)`, true);
    }
  }

  // 2. referenced paths exist in repo/ or changes/
  let pathsOk = true;
  const missingPaths = [];
  for (const p of eventPathSet) {
    if (!existsSync(path.join(dir, "repo", p)) && !existsSync(path.join(dir, "changes", p))) {
      pathsOk = false;
      missingPaths.push(p);
    }
  }
  check(
    `${prefix} ${eventPathSet.size} referenced paths exist in repo/ or changes/`,
    pathsOk,
    missingPaths.slice(0, 5).join(", ")
  );

  // 3. labels
  const labelsDir = path.join(dir, "labels");
  const attentionRaw = existsSync(path.join(labelsDir, "attention.json"))
    ? readJson(path.join(labelsDir, "attention.json"))
    : { __parseError: "missing" };
  const projectionRaw = existsSync(path.join(labelsDir, "projection.json"))
    ? readJson(path.join(labelsDir, "projection.json"))
    : { __parseError: "missing" };

  check(`${prefix} labels/attention.json parses`, !attentionRaw.__parseError, attentionRaw.__parseError);
  check(`${prefix} labels/projection.json parses`, !projectionRaw.__parseError, projectionRaw.__parseError);

  const attentionLabels = attentionRaw.__parseError ? {} : attentionRaw;
  const projectionLabels = projectionRaw.__parseError ? {} : projectionRaw;
  const surfacedSlugs = [];

  let attentionOk = true;
  for (const [slug, label] of Object.entries(attentionLabels)) {
    const result = AttentionDecisionSchema.safeParse(label);
    if (!result.success) {
      check(`${prefix} attention label '${slug}' validates AttentionDecisionSchema`, false, zodIssues(result));
      attentionOk = false;
      continue;
    }
    const probSum = Object.values(label.probabilities).reduce((a, b) => a + b, 0);
    if (probSum < 0.99 || probSum > 1.01) {
      check(`${prefix} attention label '${slug}' probabilities sum to ~1`, false, `sum=${probSum.toFixed(3)}`);
      attentionOk = false;
      continue;
    }
    if (label.shouldSurface) surfacedSlugs.push(slug);
  }
  check(`${prefix} all ${Object.keys(attentionLabels).length} attention labels valid`, attentionOk);

  const attentionSlugs = new Set(Object.keys(attentionLabels));
  const surfacedSet = new Set(surfacedSlugs);

  let projectionOk = true;
  for (const [slug, intent] of Object.entries(projectionLabels)) {
    if (!attentionSlugs.has(slug)) {
      check(`${prefix} projection slug '${slug}' exists in attention labels`, false);
      projectionOk = false;
      continue;
    }
    if (!surfacedSet.has(slug)) {
      check(`${prefix} projection slug '${slug}' is surfaced (shouldSurface=true)`, false);
      projectionOk = false;
      continue;
    }
    const result = UIIntentSchema.safeParse(intent);
    if (!result.success) {
      check(`${prefix} projection '${slug}' validates UIIntentSchema`, false, zodIssues(result));
      projectionOk = false;
      continue;
    }
    const attention = attentionLabels[slug];
    const expectedRep = CATEGORY_TO_REPRESENTATION[attention.semanticCategory];
    if (intent.representation !== expectedRep) {
      check(
        `${prefix} projection '${slug}' representation matches ${attention.semanticCategory} -> ${expectedRep}`,
        false,
        `got ${intent.representation}`
      );
      projectionOk = false;
    }
    const badViews = intent.secondaryViews.filter((v) => !CATALOG_COMPONENTS.has(v));
    if (badViews.length > 0) {
      check(`${prefix} projection '${slug}' secondaryViews are catalog components`, false, badViews.join(", "));
      projectionOk = false;
    }
    const expectedMode = expectedRenderMode(intent.confidence);
    if (intent.renderMode !== expectedMode) {
      check(
        `${prefix} projection '${slug}' renderMode follows confidence policy`,
        false,
        `confidence=${intent.confidence} expected ${expectedMode} got ${intent.renderMode}`
      );
      projectionOk = false;
    }
    if (intent.attention === "interrupt" && intent.renderMode === "suppressed") {
      check(`${prefix} projection '${slug}' interrupt attention always renders`, false);
      projectionOk = false;
    }
  }
  check(`${prefix} all ${Object.keys(projectionLabels).length} projection labels valid`, projectionOk);

  const surfacedMissingProjection = [...surfacedSet].filter((s) => !(s in projectionLabels));
  check(
    `${prefix} every surfaced unit has a projection label`,
    surfacedMissingProjection.length === 0,
    surfacedMissingProjection.join(", ")
  );

  // 4. golden specs
  const specsDir = path.join(dir, "golden_specs");
  let specFiles = [];
  if (existsSync(specsDir)) {
    specFiles = readdirSync(specsDir).filter((f) => f.endsWith(".json"));
  } else {
    check(`${prefix} golden_specs/ directory exists`, false);
  }

  let specsOk = true;
  for (const file of specFiles) {
    const slug = file.replace(/\.json$/, "");
    const spec = readJson(path.join(specsDir, file));
    const tag = `${prefix} golden_specs/${file}`;
    if (spec.__parseError) {
      check(`${tag} parses`, false, spec.__parseError);
      specsOk = false;
      continue;
    }
    if (!surfacedSet.has(slug)) {
      check(`${tag} slug '${slug}' is a surfaced attention label`, false);
      specsOk = false;
      continue;
    }
    const schemaResult = JsonRenderSpecSchema.safeParse(spec);
    if (!schemaResult.success) {
      check(`${tag} validates JsonRenderSpecSchema`, false, zodIssues(schemaResult));
      specsOk = false;
      continue;
    }
    const elements = spec.elements;
    const rootId = spec.root;
    if (!(rootId in elements)) {
      check(`${tag} root id '${rootId}' exists in elements`, false);
      specsOk = false;
      continue;
    }
    let childrenOk = true;
    for (const [id, element] of Object.entries(elements)) {
      for (const childId of element.children ?? []) {
        if (!(childId in elements)) {
          check(`${tag} child id '${childId}' of '${id}' exists`, false);
          childrenOk = false;
        }
      }
    }
    check(`${tag} all child ids exist`, childrenOk);

    const visited = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const childId of elements[current].children ?? []) {
        if (!visited.has(childId)) {
          visited.add(childId);
          queue.push(childId);
        }
      }
    }
    const orphans = Object.keys(elements).filter((id) => !visited.has(id));
    check(`${tag} no orphan elements`, orphans.length === 0, orphans.join(", "));

    const badTypes = Object.values(elements)
      .map((e) => e.type)
      .filter((t) => !CATALOG_COMPONENTS.has(t));
    check(`${tag} element types are catalog components`, badTypes.length === 0, [...new Set(badTypes)].join(", "));

    const actions = collectSpecActions(spec);
    const badActions = actions.filter((a) => !ACTION_ALLOWLIST.has(a));
    check(`${tag} actions are allowlisted`, badActions.length === 0, [...new Set(badActions)].join(", "));

    const expectedRoot = CATEGORY_TO_ROOT_COMPONENT[attentionLabels[slug].semanticCategory];
    if (elements[rootId].type !== expectedRoot) {
      check(
        `${tag} root component matches ${attentionLabels[slug].semanticCategory} -> ${expectedRoot}`,
        false,
        `got ${elements[rootId].type}`
      );
      specsOk = false;
    }
  }
  check(`${prefix} ${specFiles.length} golden specs structurally valid`, specsOk);

  const specSlugs = new Set(specFiles.map((f) => f.replace(/\.json$/, "")));
  const surfacedWithoutSpec = [...surfacedSet].filter((s) => !specSlugs.has(s));
  check(
    `${prefix} every surfaced unit has a golden spec`,
    surfacedWithoutSpec.length === 0,
    surfacedWithoutSpec.join(", ")
  );
  const specWithoutSurface = [...specSlugs].filter((s) => !surfacedSet.has(s));
  check(
    `${prefix} no golden spec for unsurfaced units`,
    specWithoutSurface.length === 0,
    specWithoutSurface.join(", ")
  );

  // 5. expected units
  const unitsRaw = existsSync(path.join(dir, "expected_units.json"))
    ? readJson(path.join(dir, "expected_units.json"))
    : { __parseError: "missing" };
  check(`${prefix} expected_units.json parses`, !unitsRaw.__parseError, unitsRaw.__parseError);
  if (unitsRaw.__parseError) {
    return;
  }
  if (!Array.isArray(unitsRaw)) {
    check(`${prefix} expected_units.json is an array`, false);
    return;
  }
  const unitIds = new Set();
  let unitsOk = true;
  for (const unit of unitsRaw) {
    const tag = `${prefix} expected unit '${unit?.id ?? "?"}'`;
    if (!unit || typeof unit !== "object" || typeof unit.id !== "string" || typeof unit.title !== "string") {
      check(`${tag} has id and title`, false);
      unitsOk = false;
      continue;
    }
    if (unitIds.has(unit.id)) {
      check(`${tag} id is unique`, false);
      unitsOk = false;
    }
    unitIds.add(unit.id);
    const catResult = ChangeCategorySchema.safeParse(unit.category);
    if (!catResult.success) {
      check(`${tag} category is a valid ChangeCategory`, false, zodIssues(catResult));
      unitsOk = false;
    }
    if (!attentionSlugs.has(unit.id)) {
      check(`${tag} id exists in attention labels`, false);
      unitsOk = false;
    }
    const missingFiles = (unit.files ?? []).filter((f) => !eventPathSet.has(f));
    if (missingFiles.length > 0) {
      check(`${tag} files appear in events.jsonl`, false, missingFiles.join(", "));
      unitsOk = false;
    }
    const missingSymbols = (unit.symbolNames ?? []).filter((s) => !eventSymbolSet.has(s));
    if (missingSymbols.length > 0) {
      check(`${tag} symbolNames appear in events.jsonl`, false, missingSymbols.join(", "));
      unitsOk = false;
    }
  }
  check(`${prefix} all ${unitsRaw.length} expected units valid`, unitsOk);

  const attentionWithoutUnit = [...attentionSlugs].filter((s) => !unitIds.has(s));
  check(
    `${prefix} every attention slug has an expected unit`,
    attentionWithoutUnit.length === 0,
    attentionWithoutUnit.join(", ")
  );
  const unitWithoutAttention = [...unitIds].filter((s) => !attentionSlugs.has(s));
  check(
    `${prefix} every expected unit has an attention label`,
    unitWithoutAttention.length === 0,
    unitWithoutAttention.join(", ")
  );

  let decisionRefsOk = true;
  const decisionLines = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  for (const [lineIndex, line] of decisionLines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const decisionResult = DecisionSchema.safeParse(record);
    if (!decisionResult.success) continue;
    const decision = decisionResult.data;
    const danglingEvidence = decision.evidence.filter(
      (id) => !evidenceRefIds.has(id),
    );
    if (danglingEvidence.length > 0) {
      check(
        `${prefix} decision '${decision.id}' evidence ids exist in the stream`,
        false,
        `line ${lineIndex + 1}: ${danglingEvidence.join(", ")}`
      );
      decisionRefsOk = false;
    }
    const unknownUnits = decision.affectedChangeUnits.filter(
      (id) => !attentionSlugs.has(id),
    );
    if (unknownUnits.length > 0) {
      check(
        `${prefix} decision '${decision.id}' affectedChangeUnits are expected units`,
        false,
        `line ${lineIndex + 1}: ${unknownUnits.join(", ")}`
      );
      decisionRefsOk = false;
    }
  }
  check(`${prefix} all decision references resolve`, decisionRefsOk);
}

function collectPathsAndSymbols(record, eventPathSet, eventSymbolSet) {
  switch (record.type) {
    case "git_hunk":
      eventPathSet.add(record.file);
      break;
    case "file_changed":
      eventPathSet.add(record.path);
      break;
    case "file_read":
      eventPathSet.add(record.path);
      break;
    case "symbol_delta":
      eventPathSet.add(record.path);
      for (const symbol of [...record.added, ...record.removed, ...record.modified]) {
        eventSymbolSet.add(symbol.name);
      }
      break;
    case "dependency_change":
      eventPathSet.add(record.manifest);
      break;
    case "test_result":
      for (const failure of record.failures) {
        eventPathSet.add(failure.file);
      }
      break;
    default:
      break;
  }
  if (record.kind && Array.isArray(record.files)) {
    for (const file of record.files) {
      eventPathSet.add(file);
    }
    for (const symbol of record.symbols ?? []) {
      eventSymbolSet.add(symbol);
    }
    for (const ref of record.evidence ?? []) {
      if (["file", "git_hunk", "symbol", "test_output"].includes(ref.type) && isPathLike(ref.sourceId)) {
        eventPathSet.add(ref.sourceId);
      }
    }
  }
}

console.log("Jevcode fixture validator");
for (const scenario of SCENARIOS) {
  validateScenario(scenario);
}

console.log(`\n== Summary ==`);
console.log(`Checks: ${checkCount}, passed: ${checkCount - failCount}, failed: ${failCount}`);
if (failCount > 0) {
  console.log("VALIDATION FAILED");
  process.exit(1);
}
console.log("VALIDATION PASSED");
