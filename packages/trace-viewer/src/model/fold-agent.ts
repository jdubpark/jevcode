import { matchDestructive, type NormalizedAgentEvent } from "@jevcode/contracts";

import { agentEventLabel, normalizeCommand } from "./format.js";
import {
  addRowToStep,
  createStep,
  currentTurn,
  indexCallId,
  openTurn,
  setKind,
  touchTurn,
  type CallFamily,
  type FoldState,
  type QueueEntry,
  type RowContext,
  type StepDraft,
  type TurnDraft,
} from "./fold-state.js";
import { commandKind, isLockfilePath } from "./registry.js";

function queueKey(family: CallFamily, target: string): string {
  return `${family}\u0000${target}`;
}

function enqueue(turn: TurnDraft, key: string, entry: QueueEntry): void {
  const queue = turn.queues.get(key);
  if (queue === undefined) turn.queues.set(key, [entry]);
  else queue.push(entry);
}

function removeFromQueue(turn: TurnDraft, key: string, step: StepDraft): void {
  const queue = turn.queues.get(key);
  if (queue === undefined) return;
  const index = queue.findIndex((entry) => entry.step === step && !entry.nested);
  if (index >= 0) queue.splice(index, 1);
}

function commandDetail(command: string): NonNullable<StepDraft["command"]> {
  const pattern = matchDestructive(command);
  return pattern === null ? { command, exitCode: null } : { command, exitCode: null, destructivePattern: pattern.name };
}

const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_MAX = 2_048;

/** CommandDetail.outputTail (spec §6.2): the last 20 lines of stdout then stderr, at most 2,048
 *  UTF-16 code units, never starting on the low half of a surrogate pair. Left unset when both
 *  streams are empty. Raw text: the UI shows it through displayUntrusted(tail, { multiline: true }). */
function setOutputTail(detail: NonNullable<StepDraft["command"]>, stdout: string, stderr: string): void {
  const parts = [stdout, stderr]
    .map((part) => part.replace(/\r\n?/g, "\n").trimEnd())
    .filter((part) => part !== "");
  if (parts.length === 0) return;
  let tail = parts.join("\n").split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  if (tail.length > OUTPUT_TAIL_MAX) {
    tail = tail.slice(tail.length - OUTPUT_TAIL_MAX);
    const first = tail.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  }
  detail.outputTail = tail;
}

function latestOpenCommand(turn: TurnDraft, normalized: string): StepDraft | undefined {
  const queue = turn.queues.get(queueKey("command", normalized)) ?? [];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const entry = queue[index];
    if (entry !== undefined && !entry.nested && entry.step.open) return entry.step;
  }
  return undefined;
}

function openCall(
  state: FoldState,
  turn: TurnDraft,
  ctx: RowContext,
  event: Extract<NormalizedAgentEvent, { type: "tool_started" | "command_started" | "test_started" }>,
): void {
  if (event.type === "tool_started") {
    const step = createStep(state, turn, ctx, {
      kind: "tool",
      source: event.type,
      status: "running",
      target: event.tool,
      approxTime: true,
      ...(event.callId !== undefined ? { callId: event.callId } : {}),
    });
    step.open = true;
    step.family = "tool";
    enqueue(turn, queueKey("tool", event.tool), { step, nested: false });
    return;
  }
  const normalized = normalizeCommand(event.command);
  if (event.type === "test_started") {
    const host = latestOpenCommand(turn, normalized);
    if (host !== undefined) {
      // A test run inside the command that launched it: one step (fixtures/*/events.jsonl).
      addRowToStep(state, host, ctx, false);
      if (host.kind === "command") setKind(state, host, "test");
      enqueue(turn, queueKey("test", normalized), { step: host, nested: true });
      return;
    }
  }
  const family: CallFamily = event.type === "test_started" ? "test" : "command";
  const kind = commandKind(event.command);
  const step = createStep(state, turn, ctx, {
    kind: family === "test" && kind === "command" ? "test" : kind,
    source: event.type,
    status: "running",
    target: event.command,
    approxTime: true,
    ...(event.type === "command_started" && event.callId !== undefined ? { callId: event.callId } : {}),
  });
  step.open = true;
  step.family = family;
  step.command = commandDetail(event.command);
  enqueue(turn, queueKey(family, normalized), { step, nested: false });
  turn.commands.set(normalized, step);
}

function closeCall(
  state: FoldState,
  turn: TurnDraft,
  ctx: RowContext,
  event: Extract<NormalizedAgentEvent, { type: "tool_completed" | "command_completed" | "test_completed" }>,
): void {
  const family: CallFamily =
    event.type === "tool_completed" ? "tool" : event.type === "command_completed" ? "command" : "test";
  const target = event.type === "tool_completed" ? event.tool : normalizeCommand(event.command);
  const key = queueKey(family, target);
  const callId = event.type === "test_completed" ? undefined : event.callId;

  let step: StepDraft | undefined;
  let observed = false;
  if (callId !== undefined) {
    const byCall = state.stepsByCallId.get(callId);
    if (byCall !== undefined && byCall.open && byCall.family === family) {
      step = byCall;
      observed = true;
      removeFromQueue(turn, key, byCall);
    }
  }
  if (step === undefined) {
    const queue = turn.queues.get(key) ?? [];
    const index = queue.findIndex(
      (entry) =>
        (entry.nested || entry.step.open) &&
        (callId === undefined || entry.step.callId === undefined || entry.step.callId === callId),
    );
    const entry = index >= 0 ? queue[index] : undefined;
    if (entry !== undefined) {
      queue.splice(index, 1);
      if (entry.nested) {
        // test_completed inside its command: the command_completed closes the step.
        addRowToStep(state, entry.step, ctx, false);
        return;
      }
      step = entry.step;
    }
  }
  if (step === undefined) {
    // A completion with no start (history cut or never emitted): a closed step of its own.
    const kind = event.type === "tool_completed" ? "tool" : commandKind(event.command);
    const orphan = createStep(state, turn, ctx, {
      kind: family === "test" && kind === "command" ? "test" : kind,
      source: event.type,
      status: "ok",
      target: event.type === "tool_completed" ? event.tool : event.command,
      approxTime: true,
      ...(callId !== undefined ? { callId } : {}),
    });
    orphan.family = family;
    if (event.type !== "tool_completed") {
      orphan.command = { ...commandDetail(event.command), exitCode: event.exitCode };
      if (event.type === "command_completed") setOutputTail(orphan.command, event.stdout, event.stderr);
      turn.commands.set(target, orphan);
    }
    return;
  }
  addRowToStep(state, step, ctx, false);
  step.open = false;
  step.endTs = ctx.sourceTs;
  step.endTMs = ctx.t;
  step.durationMs = ctx.t - step.tMs;
  if (!observed) step.provenance = "inferred";
  if (callId !== undefined && step.callId === undefined) {
    step.callId = callId;
    indexCallId(state, callId, step);
  }
  if (event.type === "tool_completed") {
    step.status = "ok";
  } else if (step.command !== undefined) {
    step.command.exitCode = event.exitCode;
    if (event.type === "command_completed") setOutputTail(step.command, event.stdout, event.stderr);
  }
}

/** An agent file_changed is a claim. It joins the path's latest edit step in the turn when that step is not claimed yet. */
function foldClaim(
  state: FoldState,
  turn: TurnDraft,
  ctx: RowContext,
  event: Extract<NormalizedAgentEvent, { type: "file_changed" }>,
): void {
  const existing = turn.edits.get(event.path);
  if (existing !== undefined && existing.edit !== undefined && !existing.edit.claimed) {
    addRowToStep(state, existing, ctx, false);
    existing.edit.claimed = true;
    existing.actor = "agent";
    if (event.callId !== undefined && existing.callId === undefined) {
      existing.callId = event.callId;
      indexCallId(state, event.callId, existing);
    }
    return;
  }
  const step = createStep(state, turn, ctx, {
    kind: "edit",
    source: event.type,
    status: "ok",
    target: event.path,
    approxTime: true,
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
  });
  step.edit = {
    path: event.path,
    added: 0,
    removed: 0,
    claimed: true,
    observed: false,
    diff: "none",
    lockfile: isLockfilePath(event.path),
    formattingOnly: false,
  };
  turn.edits.set(event.path, step);
}

/** Spec §6.6 "Instruction dedupe" for an agent_started. A prompt equal to an absorbed decision
 *  answer opens the turn without an instruction step and the turn takes the decision title; a
 *  prompt equal to an earlier undelivered user message delivers that step (the relaunch's seq joins
 *  it, and it is the turn's instruction item); any other prompt opens an instruction step. */
function deliverInstruction(state: FoldState, turn: TurnDraft, ctx: RowContext, prompt: string): void {
  const key = prompt.trim();
  const answered = state.answeredPrompts.get(key);
  if (answered !== undefined) {
    state.answeredPrompts.delete(key);
    addRowToStep(state, answered.step, ctx, false);
    turn.prompt = answered.title;
    turn.instruction = null;
    return;
  }
  const index = state.undelivered.findIndex((step) => (step.text ?? "").trim() === key);
  const queued = index >= 0 ? state.undelivered[index] : undefined;
  if (queued !== undefined) {
    state.undelivered.splice(index, 1);
    addRowToStep(state, queued, ctx, false);
    // Delivered as an instruction, so no longer a candidate decision answer.
    if (state.pendingAnswer?.step === queued) state.pendingAnswer = null;
    turn.instruction = queued;
    return;
  }
  turn.instruction = createStep(state, turn, ctx, {
    kind: "instruction",
    source: "agent_started",
    status: "info",
    actor: "supervisor",
    text: prompt,
    approxTime: true,
  });
}

export function foldAgentEvent(state: FoldState, event: NormalizedAgentEvent, ctx: RowContext): void {
  if ("callId" in event && event.callId !== undefined) state.capabilities.add("call_ids");
  if (event.type === "agent_started") {
    const last = state.turns[state.turns.length - 1];
    let turn: TurnDraft;
    if (last !== undefined && !last.started) {
      // Rows before the first agent_started opened an implicit turn; this start adopts it.
      last.started = true;
      last.prompt = event.prompt;
      last.turnId = event.turnId;
      turn = last;
    } else {
      turn = openTurn(state, ctx, { started: true, prompt: event.prompt, turnId: event.turnId });
    }
    touchTurn(turn, ctx);
    deliverInstruction(state, turn, ctx, event.prompt);
    turn.lastAgentEvent = event.type;
    return;
  }
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  if (turn.turnId === undefined && event.turnId !== undefined) turn.turnId = event.turnId;
  switch (event.type) {
    case "agent_message": {
      if (event.role === "assistant") state.capabilities.add("agent_messages");
      const opening = turn.instruction;
      if (
        event.role === "user" &&
        opening !== null &&
        turn.lastAgentEvent === "agent_started" &&
        event.text.trim() === (opening.text ?? "").trim()
      ) {
        // A steer echoes its relaunch's prompt right after the agent_started: one instruction step
        // holds both rows (spec §6.6 "Instruction dedupe"). It may still be a decision answer.
        addRowToStep(state, opening, ctx, false);
        state.pendingAnswer = { step: opening, seq: ctx.seq, t: ctx.t, sourceTs: ctx.sourceTs };
        break;
      }
      const message = createStep(state, turn, ctx, {
        kind: event.role === "user" ? "instruction" : "message",
        source: event.type,
        status: "info",
        actor: event.role === "user" ? "supervisor" : "agent",
        text: event.text,
        approxTime: true,
      });
      if (event.role === "user") {
        // The latest user message may answer an open decision; the next decision row decides (R25).
        // A later relaunch with the same prompt delivers it (spec §6.6).
        state.pendingAnswer = { step: message, seq: ctx.seq, t: ctx.t, sourceTs: ctx.sourceTs };
        state.undelivered.push(message);
      }
      break;
    }
    case "agent_reasoning":
      createStep(state, turn, ctx, {
        kind: "reasoning",
        source: event.type,
        status: "info",
        text: event.text,
        approxTime: true,
        ...(event.callId !== undefined ? { callId: event.callId } : {}),
      });
      break;
    case "tool_started":
    case "command_started":
    case "test_started":
      if (event.type === "command_started") state.capabilities.add("agent_commands");
      openCall(state, turn, ctx, event);
      break;
    case "tool_completed":
    case "command_completed":
    case "test_completed":
      if (event.type === "command_completed") state.capabilities.add("agent_commands");
      closeCall(state, turn, ctx, event);
      break;
    case "file_read":
      createStep(state, turn, ctx, {
        kind: "read",
        source: event.type,
        status: "info",
        target: event.path,
        approxTime: true,
      });
      break;
    case "file_changed":
      foldClaim(state, turn, ctx, event);
      break;
    case "approval_requested":
      createStep(state, turn, ctx, {
        kind: "approval",
        source: event.type,
        status: "info",
        target: event.command,
        approxTime: true,
        ...(event.callId !== undefined ? { callId: event.callId } : {}),
      });
      break;
    case "agent_waiting":
    case "agent_completed":
    case "agent_failed":
    case "agent_interrupted":
      createStep(state, turn, ctx, {
        kind: "lifecycle",
        source: event.type,
        status: event.type === "agent_failed" ? "failed" : event.type === "agent_completed" ? "ok" : "info",
        label: agentEventLabel(event),
        approxTime: true,
      });
      if (event.type !== "agent_waiting") {
        turn.terminal =
          event.type === "agent_interrupted" ? { type: event.type, reason: event.reason } : { type: event.type };
      }
      break;
  }
  turn.lastAgentEvent = event.type;
}
