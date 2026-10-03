import { useContext, useEffect, useId, useMemo, useReducer, type JSX } from "react";

import { buildBrief, type BriefArchitecture, type BriefChange, type BriefModel } from "../../layout/brief.js";
import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  agentStateLabel,
  displayUntrusted,
  formatDuration,
  overviewStatusOf,
  type OverviewModel,
  type Chapter,
  type Step,
  type StepId,
  type StepKind,
  type TraceSession,
} from "../../model/index.js";
import { DiffBar } from "../graphics/DiffBar.js";
import { DurationBar } from "../graphics/DurationBar.js";
import { TestDots } from "../graphics/TestDots.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON } from "../icons/kind-icons.js";
import { useViewerHost } from "../shell/host-context.js";
import { displaySpanMs } from "../shell/TitleBar.js";
import { useSessionView } from "../shell/session-context.js";
import { useDispatch } from "../state/store.js";
import { narratorNote } from "../views/map/map-text.js";
import { ViewDefinitionsContext } from "../views/view-port.js";
import styles from "./Brief.module.css";
import { MapThumbnail } from "./MapThumbnail.js";

/** Changes the list shows before "n more" (the Changes list is a summary; the views hold the rest). */
export const BRIEF_CHANGES_SHOWN = 8;

/** Files a change row's tooltip names before "+n more". */
const TOOLTIP_FILES = 8;

/** Edited files the "not grouped yet" list shows before "n more" (before the first change unit). */
const EDITED_FILES_SHOWN = 5;

/** Test dots a change row draws at most (the H1 mockup's narrow column). */
const TALLY_DOTS = 5;

/** Step kinds whose headline is a command line or a tool name, set in mono like the Console. */
const MONO_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(["command", "test", "check", "tool"]);

export interface BriefViewProps {
  model: BriefModel;
  session: TraceSession;
  index: TraceIndex;
  /** Display-clock now, for the running bar. */
  nowT: number;
  onSelect(id: SelectionId): void;
  onOpenMap(): void;
  /** A Map view is registered (always in v1; the button hides otherwise). */
  mapAvailable: boolean;
}

function stepOf(session: TraceSession, index: TraceIndex, id: string | null): Step | undefined {
  if (id === null) return undefined;
  const entry = index.entry(id);
  return entry?.kind === "step" ? session.steps[entry.position] : undefined;
}

function chapterOf(session: TraceSession, index: TraceIndex, id: string | null): Chapter | undefined {
  if (id === null) return undefined;
  const entry = index.entry(id);
  return entry?.kind === "chapter" ? session.chapters[entry.position] : undefined;
}

/** The latest step of the agent or the supervisor: not a decision (an open one has its own card) and not Jev's own
 *  pipeline (guardrail and attention steps, which the Console shows only through their findings). */
function tailStepOf(session: TraceSession): Step | undefined {
  for (let i = session.steps.length - 1; i >= 0; i -= 1) {
    const step = session.steps[i];
    if (step !== undefined && step.kind !== "decision" && step.lane !== "jev") return step;
  }
  return undefined;
}

/** A step's full untrusted text for a tooltip: the message or command, else its headline. */
function fullTextOf(step: Step): string {
  return displayUntrusted(step.text ?? step.target ?? step.headline, { multiline: true });
}

/** The header's state word (mockup: "Live", "Completed · 6 m 40 s", "Starting"). */
function stateWord(session: TraceSession): string {
  if (session.steps.length === 0) return agentStateLabel(session.meta.state);
  if (session.live) return "Live";
  return `${agentStateLabel(session.meta.state)} · ${formatDuration(displaySpanMs(session))}`;
}

function nowIcon(session: TraceSession): IconName {
  if (session.live) return "live";
  return session.meta.state === "completed" ? "check" : "clock";
}

function StepRow({ step, onSelect, children }: { step: Step; onSelect(id: SelectionId): void; children?: JSX.Element | JSX.Element[] }) {
  const headline = displayUntrusted(step.headline);
  return (
    <button type="button" className={styles.item} title={fullTextOf(step)} onClick={() => onSelect(step.id)}>
      <Icon name={KIND_ICON[step.kind]} size={14} className={styles.icon} />
      <span className={MONO_KINDS.has(step.kind) ? `${styles.title} ${styles.mono}` : styles.title}>{headline}</span>
      {children}
    </button>
  );
}

function Now({ model, session, index, nowT, onSelect }: BriefViewProps): JSX.Element {
  const now = model.now;
  if (now.kind === "story") {
    // Lane 07 (S-4) renders the story with citation chips against the Phase C mockup.
    return <p className={styles.prose}>{now.sentences.map((sentence) => displayUntrusted(sentence.text)).join(" ")}</p>;
  }
  const running = stepOf(session, index, now.runningStepId);
  const latest = chapterOf(session, index, now.latestUnitId);
  const latestChange = model.changes.find((change) => change.unitId === now.latestUnitId);
  let decisionStep: Step | undefined;
  for (let i = session.steps.length - 1; i >= 0 && now.pendingDecisionId !== null; i -= 1) {
    const step = session.steps[i];
    if (step?.decision?.decisionId === now.pendingDecisionId && step.decision.status === "open") {
      decisionStep = step;
      break;
    }
  }
  // With nothing running: while live, the wait for the first event or the latest step (what the agent is on); once
  // the session is over, its final state (also for a session that ended before any event).
  const tail = running === undefined && session.live ? tailStepOf(session) : undefined;
  let lead: JSX.Element | null = null;
  if (running !== undefined) {
    const elapsedMs = Math.max(0, nowT - running.tMs);
    lead = (
      <StepRow step={running} onSelect={onSelect}>
        <DurationBar size="xs" durationMs={null} running elapsedMs={elapsedMs} end="none" />
        <span className={styles.meta}>{formatDuration(elapsedMs)}</span>
      </StepRow>
    );
  } else if (session.steps.length === 0 && session.live) {
    lead = (
      <p className={styles.quiet}>
        <Icon name="clock" size={14} />
        <span>Waiting for the agent's first event</span>
      </p>
    );
  } else if (tail !== undefined) {
    lead = <StepRow step={tail} onSelect={onSelect} />;
  } else if (!session.live) {
    lead = (
      <p className={styles.state}>
        <Icon name={nowIcon(session)} size={14} />
        <span className={styles.title}>{agentStateLabel(session.meta.state)}</span>
        {session.steps.length === 0 ? null : <span className={styles.meta}>{formatDuration(displaySpanMs(session))}</span>}
      </p>
    );
  }
  return (
    <div className={styles.now}>
      {lead}
      {latest === undefined ? null : (
        <button
          type="button"
          className={styles.item}
          aria-label={`Latest change: ${displayUntrusted(latest.title)}`}
          title={displayUntrusted(latest.title)}
          onClick={() => onSelect(latest.id)}
        >
          <Icon name={CATEGORY_ICON[latest.category]} size={14} className={styles.icon} />
          <span className={styles.title}>{displayUntrusted(latest.shortTitle ?? latest.title)}</span>
          {latestChange === undefined ? null : <DiffBar size="xs" added={latestChange.added} removed={latestChange.removed} />}
        </button>
      )}
      {decisionStep === undefined || decisionStep.decision === undefined ? null : (
        <button type="button" className={styles.decision} onClick={() => onSelect(decisionStep.id)}>
          <span className={styles.question}>
            <Icon name="fork" size={14} />
            <span>{displayUntrusted(decisionStep.decision.title)}</span>
          </span>
          <span className={styles.ask}>Needs your decision</span>
        </button>
      )}
    </div>
  );
}

/** One dot per test up to TALLY_DOTS, else the run's split scaled to TALLY_DOTS; a failure always keeps a red dot and a
 *  pass a green one. The row's accessible name carries the exact counts. */
function tallyOf(tests: { passed: number; failed: number }): { passed: number; failed: number } {
  const total = tests.passed + tests.failed;
  if (total <= TALLY_DOTS) return tests;
  let failed = Math.round((tests.failed / total) * TALLY_DOTS);
  if (tests.failed > 0) failed = Math.max(1, failed);
  if (tests.passed > 0) failed = Math.min(TALLY_DOTS - 1, failed);
  return { passed: TALLY_DOTS - failed, failed };
}

function ChangeRow({ change, session, index, onSelect }: { change: BriefChange; session: TraceSession; index: TraceIndex; onSelect(id: SelectionId): void }) {
  const chapter = chapterOf(session, index, change.unitId);
  const title = displayUntrusted(change.title);
  const tally = change.tests === null ? null : tallyOf(change.tests);
  const files = chapter?.files ?? [];
  const parts = [title];
  if (files.length > 0) parts.push(files.length === 1 ? "1 file" : `${files.length} files`);
  parts.push(`+${change.added} −${change.removed}`);
  if (change.tests !== null) parts.push(`${change.tests.passed} passed, ${change.tests.failed} failed`);
  if (change.attention) parts.push("needs attention");
  // The tooltip names the files in play (the context rail's list before D-3).
  const tooltip = [
    title,
    ...files.slice(0, TOOLTIP_FILES).map((file) => displayUntrusted(file)),
    ...(files.length > TOOLTIP_FILES ? [`+${files.length - TOOLTIP_FILES} more`] : []),
  ].join("\n");
  return (
    <li>
      <button
        type="button"
        className={styles.change}
        aria-label={parts.join(", ")}
        title={tooltip}
        onClick={() => onSelect(change.unitId as SelectionId)}
      >
        <Icon name={chapter === undefined ? "list" : CATEGORY_ICON[chapter.category]} size={14} className={styles.icon} />
        <span className={styles.title}>{title}</span>
        <span className={styles.diff}>
          <DiffBar size="xs" added={change.added} removed={change.removed} />
        </span>
        {tally === null ? <span /> : <TestDots size="xs" passed={tally.passed} failed={tally.failed} skipped={0} />}
        {change.attention ? <Icon name="flag" size={14} className={styles.flag} /> : <span />}
      </button>
    </li>
  );
}

interface EditedFile {
  path: string;
  added: number;
  removed: number;
  /** The file's latest edit step, which a click selects (as a file location does, Shell selectionFromStableId). */
  stepId: StepId;
  seq: number;
}

/**
 * The session's edited files, newest edit first: the D-3 rail's "Files in play" before any change unit exists, and
 * once units exist the files no unit holds yet (`ungroupedOnly`, lane triage t3).
 */
function editedFilesOf(session: TraceSession, index: TraceIndex, ungroupedOnly = false): EditedFile[] {
  const files: EditedFile[] = [];
  for (const entity of session.entities) {
    if (ungroupedOnly && entity.chapterIds.length > 0) continue;
    const stepId = entity.stepIds.at(-1);
    if (stepId === undefined) continue;
    files.push({ path: entity.path, added: entity.added, removed: entity.removed, stepId, seq: index.entry(stepId)?.firstSeq ?? 0 });
  }
  return files.sort((a, b) => b.seq - a.seq || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function EditedFiles({ files, onSelect }: { files: readonly EditedFile[]; onSelect(id: SelectionId): void }) {
  const shown = files.slice(0, EDITED_FILES_SHOWN);
  const more = files.length - shown.length;
  return (
    <>
      <p className={styles.quiet}>{`${files.length === 1 ? "1 file" : `${files.length} files`} edited · not grouped yet`}</p>
      <ul className={styles.changes} aria-label="Files edited">
        {shown.map((file) => {
          const path = displayUntrusted(file.path);
          const cut = path.lastIndexOf("/");
          return (
            <li key={file.path}>
              <button
                type="button"
                className={`${styles.change} ${styles.file}`}
                aria-label={`${path}, +${file.added} −${file.removed}`}
                title={path}
                onClick={() => onSelect(file.stepId)}
              >
                <Icon name="file" size={14} className={styles.icon} />
                <span className={styles.path}>
                  <span className={styles.name}>{path.slice(cut + 1)}</span>
                  {cut < 0 ? null : <span className={styles.dir}>{path.slice(0, cut)}</span>}
                </span>
                <span className={styles.diff}>
                  <DiffBar size="xs" added={file.added} removed={file.removed} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 ? <p className={styles.quietSmall}>{`${more} more`}</p> : null}
    </>
  );
}

function Architecture({
  architecture,
  overview,
  onOpenMap,
  mapAvailable,
}: {
  architecture: BriefArchitecture | null;
  overview: OverviewModel | null;
  onOpenMap(): void;
  mapAvailable: boolean;
}) {
  // First, so the hook order never changes between the empty, scanning and filled states.
  const host = useViewerHost();
  if (architecture === null) {
    return (
      <div className={styles.empty}>
        <Icon name="view-map" size={14} />
        <span className={styles.emptyText}>
          <span className={styles.emptyTitle}>Codebase map</span>
          <span>Appears here once this repository is scanned.</span>
        </span>
      </div>
    );
  }
  if (architecture.scanning !== null) {
    const { done, total } = architecture.scanning;
    const share = total > 0 ? Math.min(1, done / total) : 0;
    return (
      <div className={styles.empty}>
        <Icon name="view-map" size={14} />
        <span className={`${styles.emptyText} ${styles.grow}`}>
          <span className={styles.emptyTitle}>{`Mapping codebase · ${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`}</span>
          <span className={styles.progress} aria-hidden="true">
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
        </span>
      </div>
    );
  }
  const counts = `${architecture.componentCount} components${architecture.touched.length > 0 ? ` · ${architecture.touched.length} touched` : ""}`;
  const scan = overview === null ? null : overviewStatusOf(overview.snapshot).scan;
  // Ruling R3 narrator words; a Brief built without an overview keeps "Descriptions pending".
  const narrator = overview === null ? "Descriptions pending" : narratorNote(overview);
  return (
    <div className={styles.architecture} data-brief-architecture="">
      {overview === null || architecture.componentCount === 0 ? null : <MapThumbnail overview={overview} touched={architecture.touched} />}
      <p className={styles.meta}>{counts}</p>
      {scan?.state === "failed" ? (
        <p className={styles.quietSmall} title={scan.error === undefined ? undefined : displayUntrusted(scan.error)}>
          Codebase map unavailable
          {host.rescanOverview === undefined ? null : (
            <>
              {" "}
              <button type="button" className={styles.link} onClick={() => host.rescanOverview?.()}>
                Retry
              </button>
            </>
          )}
        </p>
      ) : null}
      {architecture.overviewSentences === null ? (
        narrator === null ? null : <p className={styles.quietSmall}>{narrator}</p>
      ) : (
        <p className={styles.prose}>{architecture.overviewSentences.map((sentence) => displayUntrusted(sentence.text)).join(" ")}</p>
      )}
      {mapAvailable ? (
        <button type="button" className={styles.link} onClick={onOpenMap}>
          Open the map
        </button>
      ) : null}
    </div>
  );
}

/** Presentational Brief (spec §3.3): Now, Changes so far, Architecture. Every agent or narrator string goes through displayUntrusted. */
export function BriefView(props: BriefViewProps): JSX.Element {
  const { model, session, index, onSelect } = props;
  // Lanes 06 and 07 render BriefView directly (tests, the Map), so two Briefs can share a document.
  const id = useId();
  const shown = model.changes.slice(0, BRIEF_CHANGES_SHOWN);
  const more = model.changes.length - shown.length;
  const edited = useMemo(() => editedFilesOf(session, index, model.changes.length > 0), [model.changes.length, session, index]);
  return (
    <section className={styles.brief} aria-labelledby={`${id}-title`} tabIndex={-1} data-brief="">
      <div className={styles.header}>
        <Icon name="brief" size={16} />
        <h2 id={`${id}-title`} className={styles.heading}>Brief</h2>
        <span className={styles.stateWord}>{stateWord(session)}</span>
      </div>
      <section className={styles.part} aria-labelledby={`${id}-now`}>
        <h3 id={`${id}-now`} className={styles.partTitle}>
          <Icon name={nowIcon(session)} size={14} />
          Now
        </h3>
        <Now {...props} />
      </section>
      <section className={styles.part} aria-labelledby={`${id}-changes`}>
        <h3 id={`${id}-changes`} className={styles.partTitle}>
          <Icon name="list" size={14} />
          <span>
            Changes so far
            {model.changes.length > 0 ? <span aria-hidden="true">{` · ${model.changes.length}`}</span> : null}
          </span>
        </h3>
        {model.changes.length > 0 ? (
          <ul className={styles.changes} aria-label="Changes so far">
            {shown.map((change) => (
              <ChangeRow key={change.unitId} change={change} session={session} index={index} onSelect={onSelect} />
            ))}
          </ul>
        ) : edited.length > 0 ? (
          <EditedFiles files={edited} onSelect={onSelect} />
        ) : (
          <p className={styles.quiet}>No changes yet</p>
        )}
        {more > 0 ? <p className={styles.quietSmall}>{`${more} more in the views`}</p> : null}
        {model.changes.length > 0 && edited.length > 0 ? <EditedFiles files={edited} onSelect={onSelect} /> : null}
      </section>
      <section className={styles.part} aria-labelledby={`${id}-architecture`}>
        <h3 id={`${id}-architecture`} className={styles.partTitle}>
          <Icon name="route" size={14} />
          Architecture
        </h3>
        <Architecture architecture={model.architecture} overview={session.overview} onOpenMap={props.onOpenMap} mapAvailable={props.mapAvailable} />
      </section>
    </section>
  );
}

/** The Brief of the shown session, rendered by the right panel when nothing is selected (spec §8.4). */
export function Brief(): JSX.Element {
  const { session, index, nowT, terminal } = useSessionView();
  const dispatch = useDispatch();
  const views = useContext(ViewDefinitionsContext);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const loadingId = useId();
  const model = useMemo(() => (session === null ? null : buildBrief(session, index)), [session, index]);
  const running = model !== null && model.now.kind === "rule" && model.now.runningStepId !== null;
  // The running row's bar and seconds advance once a second (the display clock; src/layout stays clock-free).
  useEffect(() => {
    if (!running || terminal) return undefined;
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [running, terminal]);
  if (session === null || model === null) {
    return (
      <section className={styles.brief} aria-labelledby={loadingId} tabIndex={-1} data-brief="">
        <div className={styles.header}>
          <Icon name="brief" size={16} />
          <h2 id={loadingId} className={styles.heading}>Brief</h2>
        </div>
        <p className={styles.quiet}>Loading</p>
      </section>
    );
  }
  return (
    <BriefView
      model={model}
      session={session}
      index={index}
      nowT={nowT()}
      onSelect={(id) => dispatch({ type: "select", id, by: "shell" })}
      onOpenMap={() => dispatch({ type: "view/switch", view: "map" })}
      mapAvailable={views.some((view) => view.kind === "map")}
    />
  );
}
