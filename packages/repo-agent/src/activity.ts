import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { clean } from "./io.js";

export interface Activity {
  source: string;
  line: number;
  text: string;
  occurrences: number;
}
export interface ActivityLog {
  source: string;
  records: Activity[];
  linesRead: number;
  omitted: number;
  truncated: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Keep observable messages and command results; never ingest hidden reasoning or giant tool arguments.
function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry: unknown) => {
    const item = record(entry);
    if (["text", "input_text", "output_text"].includes(String(item.type))) return String(item.text ?? "");
    if (item.type === "tool_result") return content(item.content);
    return "";
  }).filter(Boolean).join("\n");
}

function eventText(raw: string): string {
  let data: Record<string, unknown>;
  try { data = record(JSON.parse(raw)); } catch { return /^\s*[{[]/.test(raw) ? "" : raw; }
  const item = record(data.item ?? data.payload ?? data.message ?? data);
  const type = String(item.type ?? data.type ?? "");
  if ([data.channel, item.channel].some(channel => ["analysis", "reasoning", "thinking"].includes(String(channel)))) return "";
  if (/reasoning|thinking|token_count|session_meta|turn_context/.test(type)) return "";
  if (type === "command_execution" || type === "command_completed") {
    return `Command: ${String(item.command ?? "unknown")}; exit: ${String(item.exit_code ?? item.exitCode ?? "unknown")}; status: ${String(item.status ?? "unknown")}\n${String(item.aggregated_output ?? item.output ?? "")}`;
  }
  if (type === "function_call_output") return String(item.output ?? "");
  if (!["message", "user", "assistant", "tool", "agent_message", "user_message", "assistant_message"].includes(type)
    && !(type === "" && ["user", "assistant", "tool"].includes(String(item.role)))) return "";
  const message = content(item.content) || (typeof item.message === "string" ? item.message : "") || (typeof item.text === "string" ? item.text : "");
  if (message) return `${String(item.role ?? type ?? "message")}: ${message}`;
  // Unknown structured formats remain visibly unsupported, not passed through as alleged facts.
  return "";
}

/** `tail` keeps the most recent 8 MiB of a long live session; the default keeps the beginning. */
export async function readActivity(file: string, source: string, tail = false): Promise<ActivityLog> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("Activity input must be a regular file.");
  const maxBytes = 8 * 1024 * 1024;
  const start = tail ? Math.max(0, info.size - maxBytes) : 0;
  const stream = createReadStream(file, { start, end: start + maxBytes - 1 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  // A tail read starts mid-record; the partial first line is dropped as an unsupported record.
  try { return await collectActivity(reader, source, info.size > maxBytes); }
  finally { reader.close(); stream.destroy(); }
}

/** Explicit session activity delivered over a pipe; no shared plaintext file is needed. */
export async function readActivityText(text: string, source: string): Promise<ActivityLog> {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Activity input exceeds 8 MiB.");
  return collectActivity(text.split(/\r?\n/), source, false);
}

async function collectActivity(lines: AsyncIterable<string> | Iterable<string>, source: string, truncated: boolean): Promise<ActivityLog> {
  const records: Activity[] = [];
  const seen = new Map<string, Activity>();
  let linesRead = 0;
  let unsupported = 0;
  let privateKey = false;
    for await (const line of lines) {
      linesRead += 1;
      if (line.trim() === "") continue;
      if (privateKey) {
        if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) privateKey = false;
        unsupported += 1;
        continue;
      }
      if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line) && !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
        privateKey = true;
        unsupported += 1;
        continue;
      }
      const text = clean(eventText(line)).trim();
      if (!text) { unsupported += 1; continue; }
      // Bound each record, retaining the end where command summaries usually occur.
      const clipped = text.length > 1400 ? `${text.slice(0, 800)}\n[record shortened]\n${text.slice(-500)}` : text;
      const previous = seen.get(clipped);
      if (previous) { previous.occurrences += 1; continue; }
      const entry = { source, line: linesRead, text: clipped, occurrences: 1 };
      records.push(entry);
      seen.set(clipped, entry);
    }
  // Preserve early failures/decisions and recent outcomes. Caps are disclosed to the reader.
  const important = records.filter((entry) => /fail|error|blocked|decision|rollback|revert/i.test(entry.text)).slice(0, 30);
  const kept = [...new Set([...records.slice(0, 10), ...important, ...records.slice(-40)])].sort((a, b) => a.line - b.line);
  return { source, records: kept, linesRead, omitted: records.length - kept.length + unsupported, truncated };
}
