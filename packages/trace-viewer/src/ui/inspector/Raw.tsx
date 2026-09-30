import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TRACE_PAYLOADS_MAX, type TraceRow } from "@jevcode/contracts";

import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import { displayUntrusted, type TraceSession } from "../../model/index.js";
import { useSessionView } from "../shell/session-context.js";
import styles from "./Inspector.module.css";

export type PayloadState =
  | { status: "loading" }
  | { status: "ready"; rows: TraceRow[] }
  | { status: "error"; message: string };

/** Fetches full rows through TraceSource.payloads; refetches only when the seq list changes or on retry. */
export function usePayloadRows(seqs: readonly number[]): { state: PayloadState; retry(): void } {
  const { payloads } = useSessionView();
  const fetchRows = useRef(payloads);
  fetchRows.current = payloads;
  const key = seqs.join(",");
  const [attempt, setAttempt] = useState(0);
  // State is stored with the request it answers, so a changed key or retry reads as loading at once.
  const request = `${key}#${attempt}`;
  const [settled, setSettled] = useState<{ request: string; state: PayloadState }>({
    request,
    state: { status: "loading" },
  });
  const state: PayloadState =
    key === "" ? { status: "ready", rows: [] } : settled.request === request ? settled.state : { status: "loading" };
  useEffect(() => {
    if (key === "") return undefined;
    let cancelled = false;
    fetchRows.current(key.split(",").map(Number)).then(
      (rows) => {
        if (!cancelled) setSettled({ request, state: { status: "ready", rows } });
      },
      (error: unknown) => {
        if (!cancelled) {
          setSettled({ request, state: { status: "error", message: error instanceof Error ? error.message : String(error) } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, request]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

export function selectionSeqs(session: TraceSession, index: TraceIndex, id: SelectionId): number[] {
  const entry = index.entry(id);
  if (entry?.kind === "chapter") {
    const chapter = session.chapters[entry.position];
    if (chapter === undefined) return [];
    return [...new Set([chapter.firstSeq, chapter.lastSeq, ...chapter.factSeqs])].sort((a, b) => a - b);
  }
  const step = entry === undefined ? undefined : session.steps[entry.position];
  return step === undefined ? [] : [...step.seqs];
}

export function PayloadError({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <p className={styles.error}>
      <span>{`Could not load rows: ${displayUntrusted(message)}`}</span>
      <button type="button" className={styles.inlineButton} onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

export function Raw({ selection }: { selection: SelectionId | null }) {
  const { session, index } = useSessionView();
  const all = useMemo(
    () => (session === null || selection === null ? [] : selectionSeqs(session, index, selection)),
    [session, index, selection],
  );
  const shown = useMemo(() => all.slice(0, TRACE_PAYLOADS_MAX), [all]);
  const { state, retry } = usePayloadRows(shown);
  if (selection === null) return <p className={styles.muted}>Select an item to see its rows</p>;
  return (
    <div className={styles.raw}>
      {state.status === "loading" ? <p className={styles.muted}>Loading rows</p> : null}
      {state.status === "error" ? <PayloadError message={state.message} onRetry={retry} /> : null}
      {state.status === "ready"
        ? state.rows.map((row) => (
            <figure key={row.seq} className={styles.rawRow}>
              <figcaption className={styles.muted}>
                {`seq ${row.seq} · ${row.type}`}
                {row.clipped === true ? " · Clipped to head + tail (16 KiB)" : ""}
              </figcaption>
              <pre className={styles.mono}>{displayUntrusted(JSON.stringify(row, null, 2), { multiline: true })}</pre>
            </figure>
          ))
        : null}
      {all.length > shown.length ? <p className={styles.muted}>{`${all.length - shown.length} more`}</p> : null}
    </div>
  );
}
