import type {
  AttentionDecision,
  Decision,
  EvidenceFact,
  JevDecisionLog,
  SemanticEvent,
  UIIntent,
} from "@jevcode/contracts";
import {
  attentionInputFromChangeUnit,
  buildJevDecisionRecord,
  chunkAttentionBatch,
  clampAttention,
  clampProjection,
  hashInput,
  preClampAttention,
  renderPolicy,
} from "@jevcode/jev-router";
import type { JevClient, SessionContext } from "@jevcode/jev-router";
import { categoryForEventKind } from "@jevcode/semantic-core";
import type { JevcodeDb } from "@jevcode/storage";
import type { PipelineCoordinator } from "@jevcode/semantic-core";

import type { JevStageUnitState } from "./types.js";
import { redactEvidenceFact, redactText } from "./redactor.js";

export interface JevStageDeps {
  db: JevcodeDb;
  coordinator: PipelineCoordinator;
  client: JevClient;
  sessionId: string;
  taskPrompt: string;
  facts: readonly EvidenceFact[];
  decisions: readonly Decision[];
  semanticEvents: readonly SemanticEvent[];
  nowIso: () => string;
  resolveSlug?: (files: readonly string[], symbols: readonly string[]) => string | undefined;
  onJevLog?: (log: JevDecisionLog) => void;
  onRedaction?: (count: number) => void;
  /**
   * Receives each write (a Jev decision row with its log callback, or a label result) in order instead of running it.
   * The turn-end sync defers them past the client's awaits and runs them in one transaction (lane 03 D-6). Absent:
   * each write runs at once.
   */
  defer?: (write: () => void) => void;
}

export interface JevUnitOutcome {
  unitId: string;
  version: number;
  state: JevStageUnitState;
  attention?: AttentionDecision;
  intent?: UIIntent;
  replaySlug?: string;
}

export interface JevStageResult {
  outcomes: JevUnitOutcome[];
  logs: JevDecisionLog[];
}

const latencyOf = (startMs: number): number => Math.max(0, Date.now() - startMs);

function clientKindOf(
  result: { clientKind?: "typesafe" | "degrade" | "playback" } | undefined,
): JevDecisionLog["clientKind"] {
  return result?.clientKind ?? "degrade";
}

function titlePatchForUnit(
  unitId: string,
  semanticEvents: readonly SemanticEvent[],
): string | undefined {
  for (const event of semanticEvents) {
    if (event.changeUnitId === unitId && event.summary.length > 0) {
      return event.summary;
    }
  }
  return undefined;
}

export async function runJevStage(deps: JevStageDeps): Promise<JevStageResult> {
  const { db, coordinator, client } = deps;
  const write = deps.defer ?? ((op: () => void) => op());
  const record = (log: JevDecisionLog): void => {
    write(() => {
      db.upsertJevDecision(log);
      deps.onJevLog?.(log);
    });
  };
  const snapshot = coordinator.snapshot();
  const outcomes: JevUnitOutcome[] = [];
  const logs: JevDecisionLog[] = [];

  let redactionCount = 0;
  const redactedPrompt = redactText(deps.taskPrompt);
  redactionCount += redactedPrompt.count;
  const redactedFacts = deps.facts.map((fact) => {
    const redacted = redactEvidenceFact(fact);
    redactionCount += redacted.count;
    return redacted.fact;
  });
  const redactedUnits = new Map<string, (typeof snapshot.units)[number]>();
  for (const unit of snapshot.units) {
    const title = redactText(unit.title);
    redactionCount += title.count;
    if (unit.intent !== undefined) {
      const intent = redactText(unit.intent);
      redactionCount += intent.count;
      redactedUnits.set(unit.id, { ...unit, title: title.text, intent: intent.text });
    } else {
      redactedUnits.set(unit.id, { ...unit, title: title.text });
    }
  }
  if (redactionCount > 0) {
    deps.onRedaction?.(redactionCount);
  }

  const sessionCtx: SessionContext = {
    sessionId: deps.sessionId,
    taskPrompt: redactedPrompt.text,
    facts: redactedFacts,
    decisionsForUnit: {},
  };
  for (const decision of deps.decisions) {
    for (const unitId of decision.affectedChangeUnits) {
      const list = sessionCtx.decisionsForUnit?.[unitId] ?? [];
      if (!list.includes(decision.id)) {
        list.push(decision.id);
        sessionCtx.decisionsForUnit = {
          ...sessionCtx.decisionsForUnit,
          [unitId]: list,
        };
      }
    }
  }

  for (const batch of chunkAttentionBatch(snapshot.units)) {
    const inputs = batch.map((unit) =>
      attentionInputFromChangeUnit(
        redactedUnits.get(unit.id) ?? unit,
        sessionCtx,
        snapshot.decisionVersions.get(unit.id) ?? 1,
      ),
    );
    const started = Date.now();
    const results = await client.attention(inputs);
    for (let i = 0; i < batch.length; i += 1) {
      const unit = batch[i];
      const input = inputs[i];
      const result = results[i];
      if (unit === undefined || input === undefined || result === undefined) {
        continue;
      }
      const version = snapshot.decisionVersions.get(unit.id) ?? 1;
      const replaySlug = deps.resolveSlug?.(input.files, input.symbols);
      const pre = preClampAttention(input);

      if (pre.forced.shouldSurface === false) {
        // The client did answer this unit; the guardrail overrode it. Log who
        // answered and how sure it was, not a synthetic degrade at 1.0.
        const log: JevDecisionLog = {
          ...buildJevDecisionRecord({
            sessionId: deps.sessionId,
            changeUnitId: unit.id,
            inputHash: hashInput(input),
            output: {
              shouldSurface: false,
              clamps: pre.clamps,
              guardrailSuppression: true,
            },
            confidence: result.confidence,
            probabilities: undefined,
            latencyMs: latencyOf(started),
            clientKind: clientKindOf(result),
            clamps: pre.clamps,
            ts: deps.nowIso(),
          }),
          pass: "A",
        };
        record(log);
        logs.push(log);
        outcomes.push({
          unitId: unit.id,
          version,
          state: { signature: "", version, shouldSurface: false },
          replaySlug,
        });
        continue;
      }

      const clamped = clampAttention(input, result.value, pre);
      const attention = clamped.value;
      const attentionLog: JevDecisionLog = {
        ...buildJevDecisionRecord({
          sessionId: deps.sessionId,
          changeUnitId: unit.id,
          inputHash: hashInput(input),
          output: attention,
          confidence: result.confidence,
          probabilities: attention.probabilities,
          latencyMs: latencyOf(started),
          clientKind: clientKindOf(result),
          clamps: clamped.clamps,
          ts: deps.nowIso(),
        }),
        pass: "A",
      };
      record(attentionLog);
      logs.push(attentionLog);

      if (!attention.shouldSurface) {
        outcomes.push({
          unitId: unit.id,
          version,
          state: { signature: "", version, shouldSurface: false, attention },
          attention,
          replaySlug,
        });
        continue;
      }

      const projectionStarted = Date.now();
      const projection = await client.project({ ...input, attention });
      const clampedProjection = clampProjection({ ...input, attention }, projection.value);
      const policy = renderPolicy({
        value: clampedProjection.value,
        confidence: projection.confidence,
        probabilities: projection.probabilities,
        clientKind: projection.clientKind,
        heuristic: projection.heuristic,
      });
      const intent = policy.value;
      const projectionLog: JevDecisionLog = {
        ...buildJevDecisionRecord({
          sessionId: deps.sessionId,
          changeUnitId: unit.id,
          inputHash: hashInput({ ...input, attention }),
          output: intent,
          confidence: policy.confidence,
          probabilities: policy.probabilities,
          latencyMs: latencyOf(projectionStarted),
          clientKind: clientKindOf(policy),
          clamps: clampedProjection.clamps,
          ts: deps.nowIso(),
        }),
        pass: "B",
      };
      record(projectionLog);
      logs.push(projectionLog);

      if (intent.renderMode === "suppressed") {
        outcomes.push({
          unitId: unit.id,
          version,
          state: { signature: "", version, shouldSurface: false, attention, intent },
          attention,
          intent,
          replaySlug,
        });
        continue;
      }

      const titlePatch = titlePatchForUnit(unit.id, deps.semanticEvents);
      const safeTitlePatch =
        titlePatch !== undefined ? redactText(titlePatch).text : titlePatch;
      write(() =>
        coordinator.applyLabelResult({
          changeUnitId: unit.id,
          decisionVersion: version,
          patch: {
            title: safeTitlePatch ?? unit.title,
            category: categoryForEventKind(attention.semanticCategory),
            importance: attention.importance,
            relevance: attention.relevance,
            interruption: attention.interruption,
            uncertainty: undefined,
            mentalModelChange: attention.mentalModelChange,
          },
        }),
      );

      outcomes.push({
        unitId: unit.id,
        version,
        state: {
          signature: "",
          version,
          shouldSurface: true,
          attention,
          intent,
        },
        attention,
        intent,
        replaySlug,
      });
    }
  }

  return { outcomes, logs };
}
