import type { NormalizedAgentEvent } from "@jevcode/contracts";
import type { EventNormalizerContext } from "@jevcode/agent-core";

import { detectAuthFailure } from "./auth.js";

interface CodexCommandExecutionItem {
  command: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status: "in_progress" | "completed" | "failed" | "declined";
}

interface CodexFileChangeItem {
  changes: { path: string; kind: "add" | "delete" | "update" }[];
  status: string;
}

interface CodexMcpToolCallItem {
  server: string;
  tool: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface CodexItem {
  id: string;
  type: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  text?: string;
  changes?: { path: string; kind: "add" | "delete" | "update" }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: string;
  item?: CodexItem;
  error?: { message?: string };
}

function parse(raw: unknown): CodexEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as CodexEvent;
  if (typeof event.type !== "string") return null;
  return event;
}

export function extractCodexThreadId(raw: unknown): string | null {
  const event = parse(raw);
  if (event === null || event.type !== "thread.started") return null;
  return typeof event.thread_id === "string" && event.thread_id !== ""
    ? event.thread_id
    : null;
}

export function mapCodexJsonlEvent(
  raw: unknown,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  const event = parse(raw);
  if (event === null) return [];

  switch (event.type) {
    case "thread.started":
    case "turn.started":
    case "item.updated":
      return [];

    case "item.started":
      return mapItemStarted(event.item, ctx);

    case "item.completed":
      return mapItemCompleted(event.item, ctx);

    case "error": {
      const message = event.message ?? event.error?.message ?? "";
      const auth = detectAuthFailure(message);
      if (auth !== null) {
        return [
          {
            type: "agent_failed",
            sessionId: ctx.sessionId,
            error: auth.message,
            ts: ctx.now(),
          },
        ];
      }
      return [];
    }

    case "turn.completed":
      return [{ type: "agent_completed", sessionId: ctx.sessionId, ts: ctx.now() }];

    case "turn.failed": {
      const message = event.error?.message ?? "turn failed";
      const auth = detectAuthFailure(message);
      return [
        {
          type: "agent_failed",
          sessionId: ctx.sessionId,
          error: auth !== null ? auth.message : message,
          ts: ctx.now(),
        },
      ];
    }

    default:
      return [];
  }
}

function mapItemStarted(
  item: CodexItem | undefined,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  if (item === undefined) return [];
  switch (item.type) {
    case "command_execution": {
      const command = item.command ?? "";
      if (command === "") return [];
      return [
        {
          type: "command_started",
          sessionId: ctx.sessionId,
          command,
          ts: ctx.now(),
        },
      ];
    }
    case "mcp_tool_call": {
      const tool = mcpToolName(item);
      return [
        {
          type: "tool_started",
          sessionId: ctx.sessionId,
          tool,
          input: JSON.stringify(item.arguments ?? {}),
          ts: ctx.now(),
        },
      ];
    }
    default:
      return [];
  }
}

function mapItemCompleted(
  item: CodexItem | undefined,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  if (item === undefined) return [];
  switch (item.type) {
    case "command_execution":
      return mapCommandCompleted(item as CodexCommandExecutionItem, ctx);

    case "agent_message":
      return item.text !== undefined
        ? [
            {
              type: "agent_message",
              sessionId: ctx.sessionId,
              role: "assistant" as const,
              text: item.text,
              ts: ctx.now(),
            },
          ]
        : [];

    case "reasoning":
      return item.text !== undefined
        ? [
            {
              type: "agent_message",
              sessionId: ctx.sessionId,
              role: "assistant" as const,
              text: item.text,
              ts: ctx.now(),
            },
          ]
        : [];

    case "file_change":
      return mapFileChange(item as CodexFileChangeItem, ctx);

    case "mcp_tool_call": {
      const call = item as CodexMcpToolCallItem;
      const output = call.result !== undefined
        ? JSON.stringify(call.result)
        : call.error !== undefined
          ? JSON.stringify(call.error)
          : "";
      return [
        {
          type: "tool_completed",
          sessionId: ctx.sessionId,
          tool: mcpToolName(item),
          output,
          ts: ctx.now(),
        },
      ];
    }

    case "todo_list":
    case "error":
    case "web_search":
    case "collab_tool_call":
      return [];

    default:
      return [];
  }
}

function mapCommandCompleted(
  item: CodexCommandExecutionItem,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  const command = item.command ?? "";
  if (command === "") return [];
  const output = item.aggregated_output ?? "";
  if (item.status === "declined") {
    return [
      {
        type: "approval_requested",
        sessionId: ctx.sessionId,
        command,
        rationale: output !== "" ? output : "command declined by codex approval policy",
        ts: ctx.now(),
      },
    ];
  }
  return [
    {
      type: "command_completed",
      sessionId: ctx.sessionId,
      command,
      exitCode: item.exit_code ?? -1,
      stdout: output,
      stderr: "",
      ts: ctx.now(),
    },
  ];
}

function mapFileChange(
  item: CodexFileChangeItem,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  if (item.status !== "completed") return [];
  return item.changes
    .filter((change) => change.path !== "")
    .map((change) => ({
      type: "file_changed" as const,
      sessionId: ctx.sessionId,
      path: change.path,
      ts: ctx.now(),
    }));
}

function mcpToolName(item: CodexItem): string {
  const server = item.server ?? "";
  const tool = item.tool ?? "";
  return server !== "" ? `${server}.${tool}` : tool;
}
