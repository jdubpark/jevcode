import { CodeDiff } from "@jevcode/ui-catalog/components/CodeDiff";

import { DecisionOptionSchema, TRACE_PAYLOADS_MAX, type DecisionOption, type TraceRow } from "@jevcode/contracts";

import type { SelectionId } from "../../layout/trace-index.js";
import { displayUntrusted, exitLabel, type Chapter, type Step, type TraceSession } from "../../model/index.js";
import { useSessionView } from "../shell/session-context.js";
import styles from "./Inspector.module.css";
import { PayloadError, usePayloadRows } from "./Raw.js";

interface DiffPayload {
  text: string;
  bytes: number;
  truncated: boolean;
  redactions: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function diffOf(row: TraceRow | undefined): DiffPayload | null {
  const diff = record(record(row?.payload).diff);
  if (typeof diff.text !== "string") return null;
  return {
    text: diff.text,
    bytes: typeof diff.bytes === "number" ? diff.bytes : diff.text.length,
    truncated: diff.truncated === true,
    redactions: typeof diff.redactions === "number" ? diff.redactions : 0,
  };
}

function utf8Length(text: string): number {
  return typeof TextEncoder === "undefined" ? text.length : new TextEncoder().encode(text).length;
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

const CLIPPED = "Clipped to head + tail (16 KiB)";

function EditEvidence({ step }: { step: Step }) {
  const edit = step.edit;
  const fetchable = edit !== undefined && edit.diffSeq !== undefined && (edit.diff === "text" || edit.diff === "truncated");
  const { state, retry } = usePayloadRows(fetchable && edit.diffSeq !== undefined ? [edit.diffSeq] : []);
  if (edit === undefined) return null;
  const header = <p className={styles.path}>{displayUntrusted(edit.path)}</p>;
  if (edit.diff === "withheld_secret") {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.label}>Diff withheld: secret path</p>
      </section>
    );
  }
  if (edit.diff === "not_captured") {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.label}>Not captured</p>
      </section>
    );
  }
  if (!fetchable) {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.muted}>No diff recorded</p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className={styles.section}>
        {header}
        <PayloadError message={state.message} onRetry={retry} />
      </section>
    );
  }
  if (state.status === "loading") {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.muted}>Loading diff</p>
      </section>
    );
  }
  const row = state.rows[0];
  const diff = diffOf(row);
  if (diff === null) {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.label}>Not captured</p>
      </section>
    );
  }
  return (
    <section className={styles.section}>
      {header}
      {diff.truncated ? (
        <p className={styles.label}>{`Truncated at hunk boundary · showing ${kb(utf8Length(diff.text))} of ${kb(diff.bytes)}`}</p>
      ) : null}
      {diff.redactions > 0 ? (
        <p className={styles.label}>{`${diff.redactions} ${diff.redactions === 1 ? "secret" : "secrets"} redacted`}</p>
      ) : null}
      {row?.clipped === true ? <p className={styles.label}>{CLIPPED}</p> : null}
      <div className={styles.diff}>
        <CodeDiff props={{ file: edit.path, diff: diff.text }} />
      </div>
    </section>
  );
}

function OutputEvidence({ step }: { step: Step }) {
  const { state, retry } = usePayloadRows(step.seqs);
  if (state.status === "error") return <PayloadError message={state.message} onRetry={retry} />;
  if (state.status === "loading") return <p className={styles.muted}>Loading output</p>;
  const completion = [...state.rows]
    .reverse()
    .find((row) => {
      const type = record(row.payload).type;
      return row.type === "agent_event" && (type === "command_completed" || type === "test_completed");
    });
  if (completion === undefined) return <p className={styles.muted}>No output recorded</p>;
  const payload = record(completion.payload);
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  return (
    <section className={styles.section}>
      <p className={styles.meta}>{exitLabel(step.command?.exitCode ?? null)}</p>
      {completion.clipped === true ? <p className={styles.label}>{CLIPPED}</p> : null}
      {stdout === "" ? null : <pre className={styles.mono}>{displayUntrusted(stdout, { multiline: true })}</pre>}
      {stderr === "" ? null : <pre className={styles.mono}>{displayUntrusted(stderr, { multiline: true })}</pre>}
      {stdout === "" && stderr === "" ? <p className={styles.muted}>The command printed nothing</p> : null}
    </section>
  );
}

/** Options with descriptions from the latest `decision` row; each option is parsed on its own. */
function decisionOptions(rows: readonly TraceRow[]): DecisionOption[] | null {
  const row = [...rows].reverse().find((candidate) => candidate.type === "decision");
  const options = record(row?.payload).options;
  if (!Array.isArray(options)) return null;
  const parsed: DecisionOption[] = [];
  for (const option of options) {
    const result = DecisionOptionSchema.safeParse(option);
    if (!result.success) return null;
    parsed.push(result.data);
  }
  return parsed;
}

function DecisionEvidence({ step }: { step: Step }) {
  const { state, retry } = usePayloadRows(step.seqs);
  const model = step.decision?.options ?? [];
  const chosen = model.filter((option) => option.chosen);
  if (state.status === "error") {
    return (
      <section className={styles.section}>
        <PayloadError message={state.message} onRetry={retry} />
      </section>
    );
  }
  const described = state.status === "ready" ? decisionOptions(state.rows) : null;
  const descriptions = new Map((described ?? []).map((option) => [option.id, option]));
  const options = described === null ? model : model.length > 0 ? model : described.map((o) => ({ id: o.id, label: o.label, chosen: false }));
  return (
    <section className={styles.section}>
      <ul className={styles.list}>
        {options.map((option) => {
          const detail = descriptions.get(option.id);
          const description = detail?.description ?? "";
          return (
            <li key={option.id} className={option.chosen ? styles.chosen : undefined}>
              <span>{displayUntrusted(detail?.label ?? option.label)}</span>
              {description === "" ? null : <span className={styles.muted}>{displayUntrusted(description)}</span>}
            </li>
          );
        })}
      </ul>
      <p className={styles.meta}>
        {chosen.length > 0 ? `Answer: ${chosen.map((option) => displayUntrusted(option.label)).join(", ")}` : "No answer yet"}
      </p>
    </section>
  );
}

function ChapterEvidence({ chapter, session }: { chapter: Chapter; session: TraceSession }) {
  const latestByPath = new Map<string, Step>();
  const members = new Set(chapter.stepIds);
  for (const step of session.steps) {
    if (members.has(step.id) && step.edit !== undefined) latestByPath.set(step.edit.path, step);
  }
  if (latestByPath.size === 0) return <p className={styles.muted}>No evidence for this item</p>;
  const steps = [...latestByPath.values()];
  const shown = steps.slice(0, TRACE_PAYLOADS_MAX);
  return (
    <>
      {shown.map((step) => (
        <EditEvidence key={step.id} step={step} />
      ))}
      {steps.length > shown.length ? <p className={styles.muted}>{`${steps.length - shown.length} more`}</p> : null}
    </>
  );
}

export function Evidence({ selection }: { selection: SelectionId | null }) {
  const { session, index } = useSessionView();
  if (session === null || selection === null) return <p className={styles.muted}>No evidence for this item</p>;
  const entry = index.entry(selection);
  if (entry?.kind === "chapter") {
    const chapter = session.chapters[entry.position];
    return chapter === undefined ? <p className={styles.muted}>No evidence for this item</p> : <ChapterEvidence chapter={chapter} session={session} />;
  }
  const step = entry === undefined ? undefined : session.steps[entry.position];
  if (step?.edit !== undefined) return <EditEvidence step={step} />;
  if (step?.command !== undefined) return <OutputEvidence step={step} />;
  if (step?.decision !== undefined) return <DecisionEvidence step={step} />;
  return <p className={styles.muted}>No evidence for this item</p>;
}
