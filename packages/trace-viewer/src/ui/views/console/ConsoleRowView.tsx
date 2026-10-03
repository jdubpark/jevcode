import { useEffect, useState, type JSX } from "react";

import { TRACE_PAYLOADS_MAX, type TraceRow } from "@jevcode/contracts";

import { CONSOLE_TAIL_LINES, type ConsoleRow } from "../../../layout/console-rows.js";
import type { TraceIndex } from "../../../layout/trace-index.js";
import {
  displayUntrusted,
  exitLabel,
  formatDuration,
  truncateMiddle,
  type FindingId,
  type Step,
  type TraceSession,
} from "../../../model/index.js";
import { DiffBar } from "../../graphics/DiffBar.js";
import { DurationBar } from "../../graphics/DurationBar.js";
import { testDotsMode } from "../../graphics/scales.js";
import { TestDots } from "../../graphics/TestDots.js";
import { Icon } from "../../icons/Icon.js";
import { FINDING_TITLE } from "../../inspector/finding-copy.js";
import styles from "./ConsoleView.module.css";

/** Failing test names a tests row shows before it is expanded. */
export const FAILING_SHOWN = 3;
/** Lines of full output an expanded command shows (the rest is counted). */
export const FULL_OUTPUT_MAX_LINES = 400;

type Row<K extends ConsoleRow["kind"]> = Extract<ConsoleRow, { kind: K }>;

/** Store key of a row's expansion (spec §8.2: expand state lives in the store, apart from Hybrid's step keys). */
export function expandKey(row: ConsoleRow): string {
  return `console:${row.key}`;
}

/**
 * A command expands only when its tail may be cut (CONSOLE_TAIL_LINES lines shown): a shorter tail is already the whole
 * output, and the approved mockup shows no chevron there.
 */
export function isExpandable(row: ConsoleRow): boolean {
  switch (row.kind) {
    case "command":
      return row.outputTail.length >= CONSOLE_TAIL_LINES;
    case "reasoning":
    case "reads":
      return true;
    case "tests":
      return row.failing.length > FAILING_SHOWN;
    default:
      return false;
  }
}

/** Virtualizer estimate before a row is measured. */
export function estimateConsoleRow(row: ConsoleRow | undefined, expanded: ReadonlySet<string>): number {
  if (row === undefined) return 24;
  const open = expanded.has(expandKey(row));
  switch (row.kind) {
    case "instruction":
      return 24 + 18 * Math.min(8, Math.floor(row.text.length / 110));
    case "message":
      return 24 + 18 * Math.min(8, Math.floor(row.text.length / 110));
    case "reasoning":
      return open ? 96 : 24;
    case "tool":
    case "edit":
    case "finding":
      return 24;
    case "command":
      return 28 + 18 * row.outputTail.length + (open ? 220 : 0);
    case "reads":
      return 24 + (open ? 24 * row.paths.length : 0);
    case "tests":
      return 44 + (open ? 18 * row.failing.length : 0);
    case "decision":
      return row.status === "pending" ? 104 : 72;
    case "lifecycle":
      return 28;
    case "summary":
      return 32 + 18 * row.sentences.length;
  }
}

/** stdout then stderr of the command_completed rows among `rows`, as lines; trailing empty lines dropped. */
export function outputLines(rows: readonly TraceRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.type !== "agent_event" || row.payload === null || typeof row.payload !== "object") continue;
    const payload = row.payload as { type?: unknown; stdout?: unknown; stderr?: unknown };
    if (payload.type !== "command_completed") continue;
    for (const part of [payload.stdout, payload.stderr]) {
      if (typeof part === "string" && part !== "") out.push(...part.split(/\r?\n/));
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function stepOf(session: TraceSession, index: TraceIndex, id: string): Step | undefined {
  const entry = index.entry(id);
  return entry?.kind === "step" ? session.steps[entry.position] : undefined;
}

/** Time since a running step started, on the display clock (running rows carry ms: null, V-3). */
function elapsedOf(step: Step | undefined, nowT: number): number {
  return Math.max(0, nowT - (step?.tMs ?? nowT));
}

/** "exit 0 · 4.1 s"; a non-zero exit reads "✕ exit 1 · 6.2 s" in the neutral meta color (only tests turn red). */
function finishedMeta(exitCode: number | null, ms: number | null): string {
  const exit = exitLabel(exitCode);
  const shown = exit !== "" && exitCode !== null && exitCode > 0 ? `✕ ${exit}` : exit;
  return [shown, formatDuration(ms)].filter((part) => part !== "").join(" · ");
}

export interface ConsoleRowViewProps {
  row: ConsoleRow;
  session: TraceSession;
  index: TraceIndex;
  expanded: boolean;
  /** id of the element that labels the row's article. */
  lineId: string;
  /** Display-clock now (SessionView.nowT()), for running bars. */
  nowT: number;
  /** The host offers answerDecision (the main window); the trace window does not. */
  canAnswer: boolean;
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  onToggle(): void;
  onOpenDiff(): void;
  onAnswer(decisionId: string, optionId: string): Promise<void>;
}

function Chevron({ open, label, onToggle }: { open: boolean; label: string; onToggle(): void }) {
  return (
    <button
      type="button"
      className={styles.chev}
      aria-expanded={open}
      aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
      onClick={onToggle}
    >
      <Icon name={open ? "chev-d" : "chev-r"} size={14} />
    </button>
  );
}

function Running({ elapsed }: { elapsed: number }) {
  return (
    <>
      <DurationBar size="xs" durationMs={null} running elapsedMs={elapsed} end="none" />
      <span>{formatDuration(elapsed)}</span>
    </>
  );
}

function FullOutput({ step, payloads }: { step: Step; payloads(seqs: readonly number[]): Promise<TraceRow[]> }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; lines: string[] } | { kind: "error" }>({
    kind: "loading",
  });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    payloads(step.seqs.slice(-TRACE_PAYLOADS_MAX)).then(
      (rows) => {
        if (!cancelled) setState({ kind: "ready", lines: outputLines(rows) });
      },
      () => {
        if (!cancelled) setState({ kind: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [step.id, step.lastSeq, payloads]);
  if (state.kind === "loading") return <p className={`${styles.output} ${styles.dim}`}>Loading output</p>;
  if (state.kind === "error") return <p className={`${styles.output} ${styles.dim}`}>The output could not be read</p>;
  const shown = state.lines.slice(-FULL_OUTPUT_MAX_LINES);
  const hidden = state.lines.length - shown.length;
  return (
    <pre className={`${styles.output} ${styles.full}`}>
      {hidden > 0 ? `${hidden} earlier lines not shown\n` : ""}
      {displayUntrusted(shown.join("\n"), { multiline: true })}
    </pre>
  );
}

/** The last output lines, one per line, cut with an ellipsis at the row edge; the full tail is the tooltip. */
function OutputTail({ lines }: { lines: readonly string[] }) {
  const text = displayUntrusted(lines.join("\n"), { multiline: true });
  return (
    <pre className={styles.output} title={text}>
      {text}
    </pre>
  );
}

function CommandRow({ row, session, index, expanded, lineId, nowT, payloads, onToggle }: ConsoleRowViewProps & { row: Row<"command"> }) {
  const step = stepOf(session, index, row.stepId);
  const command = displayUntrusted(row.command);
  return (
    <div className={styles.row}>
      <span className={styles.glyph} aria-hidden="true">$</span>
      <p id={lineId} className={`${styles.mono} ${styles.command}`}>
        {command}
      </p>
      <span className={styles.meta}>
        {row.running ? <Running elapsed={elapsedOf(step, nowT)} /> : <span>{finishedMeta(row.exitCode, row.ms)}</span>}
        {step !== undefined && (expanded || isExpandable(row)) ? (
          <Chevron open={expanded} label="output" onToggle={onToggle} />
        ) : null}
      </span>
      {expanded && step !== undefined ? (
        <FullOutput step={step} payloads={payloads} />
      ) : row.outputTail.length > 0 ? (
        <OutputTail lines={row.outputTail} />
      ) : null}
    </div>
  );
}

/** A test run (approved mockup): its command and exit over TestDots, passed/total and the failing names in red. */
function TestsRow({ row, session, index, expanded, lineId, onToggle }: ConsoleRowViewProps & { row: Row<"tests"> }) {
  const step = stepOf(session, index, row.stepId);
  const command = step?.command?.command ?? step?.target ?? "";
  const total = row.passed + row.failed;
  const inline = row.failing.slice(0, FAILING_SHOWN).map((name) => displayUntrusted(name));
  const more = row.failed - inline.length;
  const label = `${row.passed} passed, ${row.failed} failed`;
  const chevron = isExpandable(row) ? <Chevron open={expanded} label="failing tests" onToggle={onToggle} /> : null;
  const results = (
    <span className={styles.line}>
      <TestDots size="xs" passed={row.passed} failed={row.failed} skipped={0} label={label} />
      {testDotsMode(total) === "dots" ? <span className={styles.meta}>{`${row.passed}/${total}`}</span> : null}
      {inline.length > 0 && !expanded ? (
        <span className={`${styles.bad} ${styles.ellipsis}`} title={inline.join(" · ")}>
          {inline.join(" · ")}
        </span>
      ) : null}
      {more > 0 && !expanded ? <span className={`${styles.meta} ${styles.more}`}>{`${more} more`}</span> : null}
    </span>
  );
  const failingList = expanded ? (
    <ul className={styles.detail}>
      {row.failing.map((name, position) => (
        <li key={`${position}:${name}`} className={`${styles.bad} ${styles.ellipsis}`} title={displayUntrusted(name)}>
          {displayUntrusted(name)}
        </li>
      ))}
    </ul>
  ) : null;
  if (command === "") {
    return (
      <div className={styles.row}>
        <span className={styles.glyph} aria-hidden="true">
          <Icon name="test" size={14} />
        </span>
        <p id={lineId} className={styles.line}>
          {results}
        </p>
        <span className={styles.meta}>{chevron}</span>
        {failingList}
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <span className={styles.glyph} aria-hidden="true">$</span>
      <p id={lineId} className={`${styles.mono} ${styles.command}`}>
        {displayUntrusted(command)}
      </p>
      <span className={styles.meta}>
        <span>{finishedMeta(step?.command?.exitCode ?? null, step?.status === "running" ? null : (step?.durationMs ?? null))}</span>
        {chevron}
      </span>
      <div className={styles.under}>{results}</div>
      {failingList}
    </div>
  );
}

function DecisionBlock({
  row,
  lineId,
  canAnswer,
  onAnswer,
}: {
  row: Row<"decision">;
  lineId: string;
  canAnswer: boolean;
  onAnswer(decisionId: string, optionId: string): Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const labels = row.options.map((option) => displayUntrusted(option.label));
  return (
    <div className={styles.decision} data-status={row.status}>
      <p id={lineId} className={styles.question}>
        <Icon name="fork" size={14} />
        <span>{displayUntrusted(row.question)}</span>
      </p>
      {row.status === "answered" ? (
        <p className={styles.note}>{row.answer === null ? "Answered" : `→ ${displayUntrusted(row.answer)}`}</p>
      ) : canAnswer ? (
        <>
          <p className={styles.note}>Needs your decision</p>
          <div className={styles.options} role="group" aria-label="Answer">
            {row.options.map((option, position) => (
              <button
                key={option.id}
                type="button"
                className={styles.option}
                disabled={sending}
                onClick={() => {
                  setSending(true);
                  void onAnswer(row.decisionId, option.id).finally(() => setSending(false));
                }}
              >
                {labels[position]}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className={styles.note}>{`Needs your decision · ${labels.join(" / ")}`}</p>
      )}
    </div>
  );
}

/** One Console row (spec §3.2). Every agent string goes through displayUntrusted; finding titles come from the viewer. */
export function ConsoleRowView(props: ConsoleRowViewProps): JSX.Element {
  const { row, session, index, expanded, lineId, nowT, onToggle } = props;
  switch (row.kind) {
    case "instruction":
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">›</span>
          <p id={lineId} className={styles.prompt}>
            {displayUntrusted(row.text, { multiline: true })}
            {row.mode === "start" ? null : <span className={styles.tag}>{row.mode === "steer" ? "steer" : "queued"}</span>}
          </p>
        </div>
      );
    case "message":
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">·</span>
          <p id={lineId} className={styles.prose}>{displayUntrusted(row.text, { multiline: true })}</p>
        </div>
      );
    case "reasoning": {
      const text = stepOf(session, index, row.stepId)?.text ?? "";
      // A reasoning step is one row: its duration is 0 or null unless the agent reported one; "thinking" either way.
      const label = row.ms === null || row.ms <= 0 ? "thinking" : `thinking · ${formatDuration(row.ms)}`;
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">·</span>
          <p id={lineId} className={styles.dim}>{label}</p>
          <span className={styles.meta}>{text === "" ? null : <Chevron open={expanded} label="thinking" onToggle={onToggle} />}</span>
          {expanded && text !== "" ? <p className={`${styles.detail} ${styles.dim} ${styles.prose}`}>{displayUntrusted(text, { multiline: true })}</p> : null}
        </div>
      );
    }
    case "tool": {
      const step = stepOf(session, index, row.stepId);
      const name = displayUntrusted(row.name);
      const short = displayUntrusted(row.name.split(".").at(-1) ?? row.name);
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">●</span>
          <p id={lineId} className={styles.line}>
            <span className={`${styles.mono} ${styles.ellipsis}`} title={name}>
              {short}
            </span>
            {row.args === "" ? null : <span className={`${styles.mono} ${styles.dim} ${styles.ellipsis}`}>{displayUntrusted(row.args)}</span>}
          </p>
          <span className={styles.meta}>
            {row.status === "running" ? (
              <Running elapsed={elapsedOf(step, nowT)} />
            ) : step?.status === "unknown" ? (
              <span>unknown</span>
            ) : row.status === "failed" ? (
              <span>✕ failed</span>
            ) : (
              <Icon name="check" size={14} title="done" />
            )}
            {row.status === "running" || row.ms === null ? null : <span>{formatDuration(row.ms)}</span>}
          </span>
        </div>
      );
    }
    case "command":
      return <CommandRow {...props} row={row} />;
    case "reads":
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">◦</span>
          <p id={lineId} className={`${styles.dim} ${styles.ellipsis}`} title={row.paths.length === 1 ? displayUntrusted(row.paths[0] ?? "") : undefined}>
            {row.paths.length === 1 ? `read ${truncateMiddle(row.paths[0] ?? "", 64)}` : `read ${row.paths.length} files`}
          </p>
          <span className={styles.meta}>
            <Chevron open={expanded} label="files read" onToggle={onToggle} />
          </span>
          {expanded ? (
            <ul className={`${styles.detail} ${styles.paths}`}>
              {row.paths.map((path, position) => (
                <li key={`${position}:${path}`} className={`${styles.mono} ${styles.ellipsis}`} title={displayUntrusted(path)}>
                  {truncateMiddle(path, 96)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "edit":
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">✎</span>
          <p id={lineId} className={styles.line}>
            <button
              type="button"
              className={`${styles.link} ${styles.mono} ${styles.ellipsis}`}
              title={displayUntrusted(row.path)}
              onClick={props.onOpenDiff}
            >
              {truncateMiddle(row.path, 80)}
            </button>
          </p>
          <span className={styles.meta}>
            <DiffBar size="xs" added={row.added} removed={row.removed} />
            <span>{`+${row.added} −${row.removed}`}</span>
          </span>
        </div>
      );
    case "tests":
      return <TestsRow {...props} row={row} />;
    case "decision":
      return <DecisionBlock row={row} lineId={lineId} canAnswer={props.canAnswer} onAnswer={props.onAnswer} />;
    case "lifecycle":
      return (
        <div className={styles.rule} data-state={row.state}>
          <span id={lineId} className={row.state === "failed" ? styles.bad : undefined}>
            {row.state === "failed" ? `✕ ${displayUntrusted(row.text)}` : displayUntrusted(row.text)}
          </span>
        </div>
      );
    case "finding": {
      const finding = index.findingsById.get(row.findingId as FindingId);
      const critical = finding?.severity === "critical";
      // The approved mockup keeps the flag line neutral (the failing test above it is the red); a critical finding
      // keeps a red flag icon so its severity reads at a glance.
      return (
        <div className={styles.row}>
          <span className={`${styles.glyph} ${critical ? styles.bad : ""}`} aria-hidden="true">
            <Icon name="flag" size={14} />
          </span>
          <p id={lineId} className={styles.flag}>
            {finding === undefined ? "Finding" : `${FINDING_TITLE[finding.ruleId]} · ${finding.severity}`}
          </p>
        </div>
      );
    }
    case "summary":
      // Lane 07 (S-4) restyles this row against the approved Phase C mockup.
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">◆</span>
          <p id={lineId} className={styles.prose}>
            <span className={styles.summaryLabel}>Summary</span>
            {row.sentences.map((sentence) => displayUntrusted(sentence.text)).join(" ")}
          </p>
        </div>
      );
  }
}
