import { useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, type JSX, type RefObject } from "react";

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
import { DecisionCard } from "../explainer/DecisionCard.js";
import { StoryBlock } from "../explainer/StoryBlock.js";
import { DiffBar } from "../graphics/DiffBar.js";
import { DurationBar } from "../graphics/DurationBar.js";
import { TestDots } from "../graphics/TestDots.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON } from "../icons/kind-icons.js";
import { useViewerHost } from "../shell/host-context.js";
import { useDecisionAnswers, type AnswerState } from "../shell/decision-answers.js";
import { displaySpanMs } from "../shell/TitleBar.js";
import { useSessionView } from "../shell/session-context.js";
import { useDispatch, useView } from "../state/store.js";
import { narratorNote } from "../views/map/map-text.js";
import { ViewDefinitionsContext } from "../views/view-port.js";
import styles from "./Brief.module.css";
import { BriefArchitectureSection, type BriefMapSession } from "./BriefMapSession.js";
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
  /** A Map view is registered and is not the one shown (the "Open the map" button hides otherwise). */
  mapAvailable: boolean;
  /** Present only where the host can answer (the main window). */
  onAnswer?(decisionId: string, optionId: string): void;
  /** Where each decision's answer stands, by decision id (absent: "idle"). */
  answers?: ReadonlyMap<string, AnswerState>;
  /** Set while the Map is the shown view: the last part lists this session's components (lane 07 S-5). */
  mapSession?: BriefMapSession;
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

function nowIcon(session: TraceSession, model: BriefModel): IconName {
  // The narrator's story reads as Jev's (the H3 mockup's Now icon).
  if (model.now.kind === "story") return "jev";
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
    return <StoryBlock sentences={now.sentences} label="Now" {...(now.provenance !== undefined ? { provenance: now.provenance } : {})} />;
  }
  // An open decision is its card under Now (phase C, lane 07 deviation 4), so Now no longer links to it.
  const running = stepOf(session, index, now.runningStepId);
  const latest = chapterOf(session, index, now.latestUnitId);
  const latestChange = model.changes.find((change) => change.unitId === now.latestUnitId);
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
        <Icon name={nowIcon(session, model)} size={14} />
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
  const scanning = architecture.scanning;
  const scanText = scanning === null ? null : `Mapping codebase · ${scanning.done.toLocaleString("en-US")} / ${scanning.total.toLocaleString("en-US")} files`;
  const scanShare = scanning === null || scanning.total <= 0 ? 0 : Math.min(1, scanning.done / scanning.total);
  // A first scan has no components yet: the progress box alone. A rescan's progress rows carry the previous components
  // (spec §5.5), so the map stays and the progress is one quiet line under the counts (lane 06 fix I-4).
  if (scanText !== null && architecture.componentCount === 0) {
    return (
      <div className={styles.empty}>
        <Icon name="view-map" size={14} />
        <span className={`${styles.emptyText} ${styles.grow}`}>
          <span className={styles.emptyTitle}>{scanText}</span>
          <span className={styles.progress} aria-hidden="true">
            <span style={{ width: `${Math.round(scanShare * 100)}%` }} />
          </span>
        </span>
      </div>
    );
  }
  const counts = `${architecture.componentCount} ${architecture.componentCount === 1 ? "component" : "components"}${architecture.touched.length > 0 ? ` · ${architecture.touched.length} touched` : ""}`;
  const scan = overview === null ? null : overviewStatusOf(overview.snapshot).scan;
  // Ruling R3 narrator words; a Brief built without an overview keeps "Descriptions pending".
  const narrator = overview === null ? "Descriptions pending" : narratorNote(overview);
  // The paragraph is clamped to four lines, so the full text also goes in its tooltip.
  const prose = architecture.overviewSentences === null ? null : architecture.overviewSentences.map((sentence) => displayUntrusted(sentence.text)).join(" ");
  return (
    <div className={styles.architecture} data-brief-architecture="">
      {overview === null || architecture.componentCount === 0 ? null : <MapThumbnail overview={overview} touched={architecture.touched} />}
      <p className={styles.meta}>{counts}</p>
      {scanText === null ? null : (
        <p className={`${styles.quietSmall} ${styles.scanLine}`} data-brief-scan="">
          <Icon name="clock" size={12} />
          <span>{scanText}</span>
          <span className={styles.scanBar} aria-hidden="true">
            <span style={{ width: `${Math.round(scanShare * 100)}%` }} />
          </span>
        </p>
      )}
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
      {prose === null ? (
        narrator === null ? null : <p className={styles.quietSmall}>{narrator}</p>
      ) : (
        <p className={styles.prose} title={prose}>
          {prose}
        </p>
      )}
      {mapAvailable ? (
        <button type="button" className={styles.link} onClick={onOpenMap}>
          Open the map
        </button>
      ) : null}
    </div>
  );
}

/** One decision card, answering through the Brief's handler when the host can answer. */
function BriefDecision({ card, props }: { card: BriefModel["decisions"][number]; props: BriefViewProps }) {
  const onAnswer = props.onAnswer;
  return (
    <DecisionCard
      card={card}
      answer={props.answers?.get(card.decisionId) ?? "idle"}
      {...(onAnswer !== undefined ? { onAnswer: (optionId: string) => onAnswer(card.decisionId, optionId) } : {})}
    />
  );
}

function focusIsLost(doc: Document, root: HTMLElement): boolean {
  const active = doc.activeElement;
  if (active === null || active === doc.body || active === doc.documentElement) return true;
  // A Choose button disabled while its answer is on its way keeps focus in jsdom; a browser drops it to <body>.
  return active instanceof HTMLButtonElement && active.disabled && root.contains(active);
}

/**
 * A decision card that held focus can disappear under it: its Choose button is disabled while the answer is on its way,
 * and once the trace shows the decision answered the card moves from Now to Decisions (a new element). Remember which
 * card held focus and, when focus is lost after a commit, move it to that decision's card (a tabIndex -1 region), else
 * to the Decisions heading (lane 07 S-4 fix I-2). Focus that left on purpose (a click elsewhere) is forgotten.
 */
function useDecisionFocusRepair(root: RefObject<HTMLElement | null>, headingId: string): void {
  const held = useRef<string | null>(null);
  useEffect(() => {
    const node = root.current;
    const doc = node?.ownerDocument;
    if (node === null || node === undefined || doc === undefined) return undefined;
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      held.current = target instanceof Element && node.contains(target) ? (target.closest<HTMLElement>("[data-decision-id]")?.dataset.decisionId ?? null) : null;
    };
    const onFocusOut = (event: FocusEvent): void => {
      const target = event.target;
      if (held.current === null || !(target instanceof Element) || !node.contains(target) || event.relatedTarget instanceof Node) return;
      // Still in the document and still focusable a moment later: the reader moved focus away, not the commit.
      queueMicrotask(() => {
        if (target.isConnected && !(target instanceof HTMLButtonElement && target.disabled)) held.current = null;
      });
    };
    doc.addEventListener("focusin", onFocusIn);
    doc.addEventListener("focusout", onFocusOut);
    return () => {
      doc.removeEventListener("focusin", onFocusIn);
      doc.removeEventListener("focusout", onFocusOut);
    };
  }, [root]);
  useLayoutEffect(() => {
    const id = held.current;
    const node = root.current;
    const doc = node?.ownerDocument;
    if (id === null || node === null || doc === undefined || !focusIsLost(doc, node)) return;
    const card = Array.from(node.querySelectorAll<HTMLElement>("[data-decision-id]")).find((element) => element.dataset.decisionId === id);
    const heading = doc.getElementById(headingId);
    (card ?? (heading !== null && node.contains(heading) ? heading : node)).focus({ preventScroll: true });
  });
}

/**
 * Presentational Brief (spec §3.3): Now, Decisions (phase C), Changes so far, Architecture. A pending decision's card
 * sits under Now (spec §3.5); the latest decided one has its own part, as the H3 mockup shows. Every agent or narrator
 * string goes through displayUntrusted.
 */
export function BriefView(props: BriefViewProps): JSX.Element {
  const { model, session, index, onSelect } = props;
  const pending = model.decisions.filter((card) => card.status === "open");
  const decided = model.decisions.filter((card) => card.status !== "open");
  // Lanes 06 and 07 render BriefView directly (tests, the Map), so two Briefs can share a document.
  const id = useId();
  const shown = model.changes.slice(0, BRIEF_CHANGES_SHOWN);
  const more = model.changes.length - shown.length;
  const edited = useMemo(() => editedFilesOf(session, index, model.changes.length > 0), [model.changes.length, session, index]);
  const root = useRef<HTMLElement>(null);
  useDecisionFocusRepair(root, `${id}-decisions`);
  return (
    <section ref={root} className={styles.brief} aria-labelledby={`${id}-title`} tabIndex={-1} data-brief="">
      <div className={styles.header}>
        <Icon name="brief" size={16} />
        <h2 id={`${id}-title`} className={styles.heading}>Brief</h2>
        <span className={styles.stateWord}>{stateWord(session)}</span>
      </div>
      <section className={styles.part} aria-labelledby={`${id}-now`}>
        <h3 id={`${id}-now`} className={styles.partTitle}>
          <Icon name={nowIcon(session, model)} size={14} />
          Now
        </h3>
        <Now {...props} />
        {pending.map((card) => (
          <BriefDecision key={card.decisionId} card={card} props={props} />
        ))}
      </section>
      {decided.length === 0 ? null : (
        <section className={styles.part} aria-labelledby={`${id}-decisions`}>
          <h3 id={`${id}-decisions`} className={styles.partTitle} tabIndex={-1}>
            <Icon name="fork" size={14} />
            <span>
              Decisions
              <span aria-hidden="true">{` · ${decided.length}`}</span>
            </span>
          </h3>
          {decided.map((card) => (
            <BriefDecision key={card.decisionId} card={card} props={props} />
          ))}
        </section>
      )}
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
      <BriefArchitectureSection id={id} session={session} mapSession={props.mapSession}>
        <Architecture architecture={model.architecture} overview={session.overview} onOpenMap={props.onOpenMap} mapAvailable={props.mapAvailable} />
      </BriefArchitectureSection>
    </section>
  );
}

/** The Brief of the shown session, rendered by the right panel when nothing is selected (spec §8.4). */
export function Brief(): JSX.Element {
  const { session, index, nowT, terminal } = useSessionView();
  const dispatch = useDispatch();
  const views = useContext(ViewDefinitionsContext);
  const onMap = useView((state) => state.view === "map");
  const mapSelection = useView((state) => state.mapSelection);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const loadingId = useId();
  const model = useMemo(() => (session === null ? null : buildBrief(session, index)), [session, index]);
  const running = model !== null && model.now.kind === "rule" && model.now.runningStepId !== null;
  // The viewer's answers (shell/decision-answers.ts), shared with the Console's decision block and kept while the Brief
  // is unmounted: an answer on its way or sent takes no second one, and a failure offers the options again.
  const { states: answers, canAnswer, answer } = useDecisionAnswers();
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
      mapAvailable={!onMap && views.some((view) => view.kind === "map")}
      answers={answers}
      {...(onMap ? { mapSession: { selectedId: mapSelection, onSelectComponent: (componentId: string) => dispatch({ type: "map/select", componentId }) } } : {})}
      {...(canAnswer ? { onAnswer: answer } : {})}
    />
  );
}
