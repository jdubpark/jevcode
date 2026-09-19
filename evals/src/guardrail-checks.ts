import type { AttentionDecision } from "@jevcode/contracts";
import {
  DESTRUCTIVE_INTERRUPTION_FLOOR,
  attentionInputFromHints,
  clampAttention,
  degradeAttention,
  isSuppressed,
  preClampAttention,
  type AttentionInput,
} from "@jevcode/jev-router";

export interface GuardrailCheck {
  id: string;
  description: string;
  passed: boolean;
  detail: string;
}

function check(
  id: string,
  description: string,
  passed: boolean,
  detail: string,
): GuardrailCheck {
  return { id, description, passed, detail };
}

function findInput(
  inputsByScenario: ReadonlyMap<string, readonly AttentionInput[]>,
  scenario: string,
  unitId: string,
): AttentionInput {
  const inputs = inputsByScenario.get(scenario);
  const input = inputs?.find((item) => item.changeUnitId === unitId);
  if (input === undefined) {
    throw new Error(`input for "${unitId}" not found in scenario "${scenario}"`);
  }
  return input;
}

const SYNTHETIC_DESTRUCTIVE = attentionInputFromHints({
  changeUnitId: "eval-synthetic-destructive",
  decisionVersion: 1,
  sessionId: "sess-eval-synthetic",
  title: "Clean build output",
  status: "detected",
  files: ["src/tmp.ts"],
  symbols: [],
  taskPrompt: "Clean up",
  createdAt: "2026-09-19T00:00:00.000Z",
  hints: { destructiveCommands: ["rm -rf ./dist"] },
});

export function runGuardrailChecks(
  inputsByScenario: ReadonlyMap<string, readonly AttentionInput[]>,
): GuardrailCheck[] {
  const checks: GuardrailCheck[] = [];

  const formattingInput = findInput(
    inputsByScenario,
    "dep-change",
    "dep-format-noise",
  );
  const formattingSuppressed = isSuppressed(formattingInput);
  const formattingPre = preClampAttention(formattingInput);
  const formattingResult = degradeAttention(formattingInput);
  checks.push(
    check(
      "guardrail:formatting-suppression",
      "dep-format-noise (formatting-only hunk) must be suppressed",
      formattingSuppressed.reason === "formatting" &&
        formattingPre.forced.shouldSurface === false &&
        formattingPre.clamps.includes("suppress_formatting") &&
        formattingResult.value.shouldSurface === false,
      `suppression=${formattingSuppressed.reason} clamps=${formattingPre.clamps.join(",")} result.shouldSurface=${formattingResult.value.shouldSurface}`,
    ),
  );

  const securityInput = findInput(
    inputsByScenario,
    "oauth",
    "oauth-identity-layer",
  );
  const securityPre = preClampAttention(securityInput);
  const securityResult = degradeAttention(securityInput);
  checks.push(
    check(
      "guardrail:security-surface-floor",
      "oauth-identity-layer (auth paths) must surface as security_change",
      securityPre.forced.shouldSurface === true &&
        securityPre.clamps.includes("security_path") &&
        securityPre.forced.semanticCategory === "security_change" &&
        securityResult.value.shouldSurface === true &&
        securityResult.value.semanticCategory === "security_change",
      `forced=${JSON.stringify(securityPre.forced)} clamps=${securityPre.clamps.join(",")}`,
    ),
  );

  const schemaInput = findInput(
    inputsByScenario,
    "schema-change",
    "schema-users-migration",
  );
  const schemaPre = preClampAttention(schemaInput);
  const schemaResult = degradeAttention(schemaInput);
  checks.push(
    check(
      "guardrail:schema-surface-floor",
      "schema-users-migration (migrations path) must surface",
      schemaPre.forced.shouldSurface === true &&
        schemaPre.clamps.includes("schema_floor") &&
        schemaResult.value.shouldSurface === true,
      `forced=${JSON.stringify(schemaPre.forced)} clamps=${schemaPre.clamps.join(",")}`,
    ),
  );

  const destructivePre = preClampAttention(SYNTHETIC_DESTRUCTIVE);
  const syntheticModel: AttentionDecision = {
    shouldSurface: false,
    importance: 0.1,
    relevance: 0.1,
    interruption: 0.1,
    mentalModelChange: 0.1,
    semanticCategory: "implementation_change",
    scope: "local",
    humanDecision: "none",
    needsSystem2: false,
    confidence: 0.6,
    probabilities: {},
  };
  const destructiveClamped = clampAttention(
    SYNTHETIC_DESTRUCTIVE,
    syntheticModel,
    destructivePre,
  );
  const destructiveResult = degradeAttention(SYNTHETIC_DESTRUCTIVE);
  checks.push(
    check(
      "guardrail:destructive-command",
      "synthetic rm -rf must force a required decision and interruption floor",
      destructivePre.forced.humanDecision === "required" &&
        (destructivePre.forced.interruption ?? 0) >= DESTRUCTIVE_INTERRUPTION_FLOOR &&
        destructivePre.clamps.includes("destructive_command") &&
        destructiveClamped.value.humanDecision === "required" &&
        destructiveClamped.value.interruption >= DESTRUCTIVE_INTERRUPTION_FLOOR &&
        destructiveClamped.value.shouldSurface === true &&
        destructiveResult.value.shouldSurface === true,
      `forced=${JSON.stringify(destructivePre.forced)} clamped.interruption=${destructiveClamped.value.interruption} clamps=${destructivePre.clamps.join(",")}`,
    ),
  );

  return checks;
}
