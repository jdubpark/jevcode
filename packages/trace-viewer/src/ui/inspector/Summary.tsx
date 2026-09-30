import { useState, type ReactNode } from "react";

import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  clampMeta,
  describeGraphic,
  displayUntrusted,
  exitLabel,
  formatDuration,
  formatOffset,
  KIND_META,
  normalizeCommand,
  pickGraphic,
  signalMeta,
  type Chapter,
  type Finding,
  type GraphicSpec,
  type SignalId,
  type Step,
  type StepId,
  type TestFailureSummary,
  type TraceSession,
  type UnitStableId,
} from "../../model/index.js";
import { DiffBar } from "../graphics/DiffBar.js";
import { DurationBar } from "../graphics/DurationBar.js";
import { ForkGlyph } from "../graphics/ForkGlyph.js";
import { Graphic } from "../graphics/Graphic.js";
import { TestDots } from "../graphics/TestDots.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON, SIGNAL_ICON } from "../icons/kind-icons.js";
import { useDispatch } from "../state/store.js";
import { citingFindingsOf, FINDING_TITLE, findingsOf } from "./finding-copy.js";
import styles from "./Inspector.module.css";

export interface SummaryProps {
  /** Handles a Related click (the Inspector selects and keeps focus); without it the click selects directly. */
  onRelatedSelect?(id: SelectionId): void;
  session: TraceSession | null;
  index: TraceIndex;
  selection: SelectionId | null;
}

/** Related rows shown before "n more"; the expanded list stops at RELATED_MAX (the Outline lists everything). */
export const RELATED_COLLAPSED = 4;
export const RELATED_MAX = 50;

interface RelatedItem {
  id: SelectionId;
  icon: IconName;
  title: string;
  tMs: number;
  graphic: GraphicSpec | null;
  shield: boolean;
}

type Select = (id: SelectionId) => void;

function useSelect(onSelect: Select | undefined): Select {
  const dispatch = useDispatch();
  return (id) => {
    if (onSelect !== undefined) onSelect(id);
    else dispatch({ type: "select", id, by: "shell" });
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

/** Claim prose with its span underlined. Escaping would shift the span, so text that needs escaping drops the underline. */
function ClaimText({ text, span }: { text: string; span: readonly [number, number] | undefined }) {
  const safe = displayUntrusted(text);
  if (span === undefined || safe !== text) return <>{safe}</>;
  return (
    <>
      {text.slice(0, span[0])}
      <span className={styles.claimSpan}>{text.slice(span[0], span[1])}</span>
      {text.slice(span[1])}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Findings

/** Claim and guardrail findings show their evidence as structure, so their prose reason would only repeat it. */
const REASON_IS_STRUCTURE: ReadonlySet<SignalId> = new Set<SignalId>(["claim_contradicted", "guardrail_clamp"]);

/** The header already names the top finding and its severity; a secondary finding gets one icon line. */
function FindingBlock({ finding, top }: { finding: Finding; top: boolean }) {
  const reason = REASON_IS_STRUCTURE.has(finding.ruleId) ? null : displayUntrusted(finding.reason);
  if (top && reason === null) return null;
  return (
    <section className={styles.section} aria-label={FINDING_TITLE[finding.ruleId]}>
      {top ? null : (
        <p className={styles.findingLine} data-tone={finding.severity === "critical" ? "bad" : "neutral"}>
          <Icon name={SIGNAL_ICON[finding.ruleId]} size={14} className={styles.icon} />
          <span>{FINDING_TITLE[finding.ruleId]}</span>
        </p>
      )}
      {reason === null ? null : <p className={styles.prose}>{reason}</p>}
    </section>
  );
}

function testName(failure: TestFailureSummary): string {
  const parts = failure.testName.split(" > ");
  return parts.at(-1) ?? failure.testName;
}

function Failures({ failures, total }: { failures: readonly TestFailureSummary[]; total: number }) {
  if (failures.length === 0) return null;
  return (
    <Section title={total === 1 ? "Failing test" : "Failing tests"}>
      {failures.slice(0, 3).map((failure, position) => (
        <div key={`${failure.file}:${position}`} className={styles.failure}>
          <p className={styles.testName} title={displayUntrusted(failure.testName)}>
            {displayUntrusted(testName(failure))}
          </p>
          <pre className={styles.message}>{displayUntrusted(failure.message, { multiline: true })}</pre>
          <p className={styles.pathRow}>
            <Icon name="file" size={14} className={styles.icon} />
            <span className={styles.ellipsisMono}>{displayUntrusted(failure.file)}</span>
          </p>
        </div>
      ))}
      {total > 3 ? <p className={styles.muted}>{`${total - 3} more`}</p> : null}
    </Section>
  );
}

function durationEnd(step: Step): "none" | "bad_dot" | "exit_x" {
  if ((step.kind === "test" || step.kind === "check") && step.status === "failed") return "bad_dot";
  const exit = step.command?.exitCode ?? null;
  return step.kind === "command" && exit !== null && exit > 0 ? "exit_x" : "none";
}

function Row({
  icon,
  label,
  mono,
  graphic,
  metric,
  metricTone,
  title,
  onClick,
}: {
  icon: IconName;
  label: ReactNode;
  mono?: boolean;
  graphic?: ReactNode;
  metric?: string;
  metricTone?: "bad";
  title?: string;
  onClick?(): void;
}) {
  const body = (
    <>
      <Icon name={icon} size={14} className={styles.icon} />
      <span className={mono === true ? styles.ellipsisMono : styles.ellipsis} title={title}>
        {label}
      </span>
      {graphic === undefined || graphic === null ? null : <span className={styles.rowGraphic}>{graphic}</span>}
      {metric === undefined || metric === "" ? null : (
        <span className={styles.metric} data-tone={metricTone}>
          {metric}
        </span>
      )}
    </>
  );
  if (onClick === undefined) return <div className={styles.row}>{body}</div>;
  return (
    <button type="button" className={styles.row} onClick={onClick}>
      {body}
    </button>
  );
}

/** A command, test or check as evidence rows: the run (DurationBar, exit) and its test counts (TestDots, passed/total). */
function RunRows({ step, onSelect }: { step: Step; onSelect?: Select }) {
  const command = step.command === undefined ? displayUntrusted(step.headline) : displayUntrusted(normalizeCommand(step.command.command));
  const exit = step.command === undefined ? "" : exitLabel(step.command.exitCode);
  const tests = step.tests;
  const total = tests === undefined ? 0 : tests.passed + tests.failed + tests.skipped;
  const select = onSelect === undefined ? undefined : () => onSelect(step.id);
  return (
    <>
      <Row
        icon="term"
        label={command}
        mono
        graphic={
          <DurationBar
            size="xs"
            label={step.durationMs === null ? undefined : formatDuration(step.durationMs)}
            durationMs={step.status === "running" ? null : step.durationMs}
            running={step.status === "running"}
            end={durationEnd(step)}
          />
        }
        metric={exit !== "" ? exit : step.durationMs === null ? "" : formatDuration(step.durationMs)}
        onClick={select}
      />
      {tests === undefined ? null : (
        <Row
          icon="test"
          label={displayUntrusted(tests.runner ?? "tests")}
          mono
          graphic={
            <TestDots
              size="sm"
              label={`${tests.passed} passed, ${tests.failed} failed`}
              passed={tests.passed}
              failed={tests.failed}
              skipped={tests.skipped}
            />
          }
          metric={`${tests.passed}/${total}`}
          onClick={select}
        />
      )}
    </>
  );
}

function stepAt(session: TraceSession, index: TraceIndex, id: StepId): Step | undefined {
  const entry = index.entry(id);
  return entry?.kind === "step" ? session.steps[entry.position] : undefined;
}

/** Mockup Inspector for a contradicted claim: the failing test, then the evidence rows (run, tests, the claim itself). */
function ClaimEvidence({
  finding,
  step,
  session,
  index,
  onSelect,
}: {
  finding: Finding;
  step: Step;
  session: TraceSession;
  index: TraceIndex;
  onSelect: Select;
}) {
  const evidence = (finding.evidenceStepIds ?? [])
    .map((id) => stepAt(session, index, id))
    .filter((item): item is Step => item !== undefined);
  const failures = evidence.flatMap((item) => item.tests?.failures ?? []);
  const failedCount = evidence.reduce((sum, item) => sum + (item.tests?.failed ?? 0), 0);
  const claimText = finding.claim?.claim.text ?? step.text ?? "";
  return (
    <>
      <Failures failures={failures} total={Math.max(failedCount, failures.length)} />
      <Section title="Evidence">
        {evidence.map((item) => (
          <RunRows key={item.id} step={item} onSelect={onSelect} />
        ))}
        {claimText === "" ? null : (
          <Row
            icon="quote"
            label={<ClaimText text={claimText} span={finding.claimSpan} />}
            title={displayUntrusted(claimText)}
            metric={formatOffset(step.tMs)}
          />
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Kind details

function StepDetails({ step, session, onSelect }: { step: Step; session: TraceSession; onSelect: Select }) {
  if (step.tests !== undefined) {
    const tests = step.tests;
    return (
      <>
        <Section title={step.status === "failed" ? "Test run" : "Tests"}>
          <RunRows step={step} />
        </Section>
        <Failures failures={tests.failures} total={Math.max(tests.failed, tests.failures.length)} />
      </>
    );
  }
  if (step.command !== undefined) {
    return (
      <Section title={KIND_META[step.kind].label}>
        <RunRows step={step} />
        {step.command.outputTail === undefined || step.command.outputTail === "" ? null : (
          <pre className={styles.mono}>{displayUntrusted(step.command.outputTail, { multiline: true })}</pre>
        )}
      </Section>
    );
  }
  if (step.edit !== undefined) {
    const edit = step.edit;
    return (
      <Section title={KIND_META[step.kind].label}>
        <Row
          icon="file"
          label={displayUntrusted(edit.path)}
          mono
          graphic={<DiffBar size="xs" added={edit.added} removed={edit.removed} label={`+${edit.added} −${edit.removed}`} />}
          metric={`+${edit.added} −${edit.removed}`}
        />
        <p className={styles.meta}>
          {`${edit.claimed ? "Agent reported" : "Not reported by the agent"} · ${
            edit.observed ? `Repo shows +${edit.added} −${edit.removed}` : "No repo change observed"
          }`}
        </p>
      </Section>
    );
  }
  if (step.decision !== undefined) {
    const decision = step.decision;
    const options = decision.options.map((option) => ({ ...option, label: displayUntrusted(option.label) }));
    const chosen = options.filter((option) => option.chosen).map((option) => option.label);
    const affected = session.chapters.filter((chapter) =>
      chapter.decisionIds.some((id) => id.slice("decision:".length) === decision.decisionId),
    );
    return (
      <>
        <Section title="Decision">
          <ForkGlyph
            size="md"
            options={options.map((option) => ({ label: option.label, chosen: option.chosen }))}
            decidedBy={decision.decidedBy ?? "open"}
          />
          <ul className={styles.list}>
            {options.map((option) => (
              <li key={option.id} className={styles.option} data-chosen={option.chosen ? "" : undefined}>
                <Icon name={option.chosen ? "check" : "chev-r"} size={14} className={styles.icon} />
                <span>{option.label}</span>
              </li>
            ))}
          </ul>
          <p className={styles.meta}>
            {chosen.length > 0 ? `Answer: ${chosen.join(", ")}` : "No answer yet"}
            {step.durationMs === null ? "" : ` · waited ${formatDuration(step.durationMs)}`}
          </p>
        </Section>
        {affected.length > 0 ? (
          <Section title="Affects">
            {affected.slice(0, RELATED_COLLAPSED).map((chapter) => (
              <Row
                key={chapter.id}
                icon={CATEGORY_ICON[chapter.category]}
                label={displayUntrusted(chapter.title)}
                metric={formatOffset(chapter.tMs)}
                onClick={() => onSelect(chapter.id)}
              />
            ))}
            {affected.length > RELATED_COLLAPSED ? <p className={styles.muted}>{`${affected.length - RELATED_COLLAPSED} more`}</p> : null}
          </Section>
        ) : null}
      </>
    );
  }
  if (step.guardrail !== undefined) {
    return (
      <Section title="Guardrails">
        {step.guardrail.clampIds.map((id) => (
          <Row key={id} icon="shield" label={clampMeta(id).label} />
        ))}
        <p className={styles.meta}>{`${step.guardrail.clientKind} · confidence ${step.guardrail.confidence.toFixed(2)}`}</p>
      </Section>
    );
  }
  if (step.text !== undefined) {
    return (
      <Section title={step.kind === "reasoning" ? "Thinking" : KIND_META[step.kind].label}>
        <p className={styles.prose}>{step.text}</p>
      </Section>
    );
  }
  return <p className={styles.meta}>{displayUntrusted(step.headline)}</p>;
}

function ChapterDetails({ chapter, session }: { chapter: Chapter; session: TraceSession }) {
  const graphic = pickGraphic(chapter, session);
  const { cited, resolved, approx } = chapter.evidenceLinks;
  const triad: ReadonlyArray<[string, number | undefined]> = [
    ["Importance", chapter.triad.importance],
    ["Relevance", chapter.triad.relevance],
    ["Interruption", chapter.triad.interruption],
  ];
  const hasTriad = triad.some(([, value]) => value !== undefined);
  return (
    <>
      <Section title="Chapter">
        {graphic === null ? null : <Graphic spec={graphic} size="md" label={describeGraphic(graphic)} />}
        {chapter.files.map((file) => (
          <Row key={file} icon="file" label={displayUntrusted(file)} mono title={displayUntrusted(file)} />
        ))}
        <p className={styles.meta}>
          {`${resolved} of ${cited} evidence links resolve${approx > 0 ? ` · ${approx} approximated` : ""}`}
        </p>
      </Section>
      {hasTriad ? (
        <Section title={`Attention${chapter.triad.clientKind === undefined ? "" : ` · ${chapter.triad.clientKind}`}`}>
          <div className={styles.bars}>
            {triad.map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <span>{label}</span>
                <span className={styles.bar}>
                  <span className={styles.barFill} style={{ display: "block", width: `${Math.round((value ?? 0) * 100)}%` }} />
                </span>
                <span>{value === undefined ? "–" : value.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      {chapter.clampIds.length > 0 ? (
        <Section title="Guardrails">
          {chapter.clampIds.map((id) => (
            <Row key={id} icon="shield" label={clampMeta(id).label} />
          ))}
        </Section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Session summary (nothing selected)

interface SessionStats {
  commands: number;
  failedCommands: number;
  edits: number;
  added: number;
  removed: number;
  lastTests: Step | undefined;
}

const statsCache = new WeakMap<TraceSession, SessionStats>();

function sessionStats(session: TraceSession): SessionStats {
  const cached = statsCache.get(session);
  if (cached !== undefined) return cached;
  const stats: SessionStats = { commands: 0, failedCommands: 0, edits: 0, added: 0, removed: 0, lastTests: undefined };
  for (const step of session.steps) {
    if (step.tests !== undefined) stats.lastTests = step;
    if (step.command !== undefined) {
      stats.commands += 1;
      if (step.status === "failed") stats.failedCommands += 1;
    }
    if (step.edit !== undefined) {
      stats.edits += 1;
      stats.added += step.edit.added;
      stats.removed += step.edit.removed;
    }
  }
  statsCache.set(session, stats);
  return stats;
}

function SessionSummary({ session, onSelect }: { session: TraceSession; onSelect: Select }) {
  const bySignal = new Map<SignalId, Finding[]>();
  for (const finding of [...session.findings].sort((a, b) => a.anchorSeq - b.anchorSeq)) {
    const list = bySignal.get(finding.ruleId) ?? [];
    list.push(finding);
    bySignal.set(finding.ruleId, list);
  }
  const chips = [...bySignal.entries()]
    .map(([ruleId, findings]) => ({ ruleId, findings, critical: findings.some((finding) => finding.severity === "critical") }))
    .sort((a, b) => Number(b.critical) - Number(a.critical));
  const signals = session.coverage.signals;
  const active = signals.filter((signal) => signal.active);
  const inactive = signals.filter((signal) => !signal.active);
  const stats = sessionStats(session);
  const tests = stats.lastTests?.tests;
  return (
    <>
      <section className={styles.section} aria-label="Session">
        <p className={styles.prompt}>{displayUntrusted(session.meta.prompt)}</p>
        {chips.length === 0 ? (
          <p className={styles.findingLine}>
            <Icon name="check" size={14} className={styles.icon} />
            <span>{`No problems found by ${active.length} signals`}</span>
          </p>
        ) : (
          <div className={styles.chips}>
            {chips.map((chip) => (
              <button
                key={chip.ruleId}
                type="button"
                className={styles.chip}
                data-signal={chip.ruleId}
                data-tone={chip.critical ? "bad" : "neutral"}
                aria-label={`${chip.findings.length} ${FINDING_TITLE[chip.ruleId]}`}
                title={FINDING_TITLE[chip.ruleId]}
                onClick={() => {
                  const first = chip.findings[0];
                  if (first !== undefined) onSelect(first.anchorStepId);
                }}
              >
                <Icon name={SIGNAL_ICON[chip.ruleId]} size={14} className={styles.icon} />
                <span>{chip.findings.length}</span>
              </button>
            ))}
            <span className={styles.hint} aria-label="n and Shift+N step through findings">
              <kbd className={styles.kbd}>n</kbd>
              <kbd className={styles.kbd}>N</kbd>
            </span>
          </div>
        )}
      </section>
      <Section title="Activity">
        <Row icon="term" label="Commands" metric={String(stats.commands)} graphic={
          stats.failedCommands > 0 ? <span className={styles.badCount}>{`✕ ${stats.failedCommands}`}</span> : null
        } />
        <Row
          icon="edit"
          label="Edits"
          graphic={stats.edits > 0 ? <DiffBar size="xs" added={stats.added} removed={stats.removed} label={`+${stats.added} −${stats.removed}`} /> : null}
          metric={`+${stats.added} −${stats.removed}`}
        />
        {tests === undefined ? null : (
          <Row
            icon="test"
            label="Tests"
            graphic={
              <TestDots size="sm" label={`${tests.passed} passed, ${tests.failed} failed`} passed={tests.passed} failed={tests.failed} skipped={tests.skipped} />
            }
            metric={`${tests.passed}/${tests.passed + tests.failed + tests.skipped}`}
          />
        )}
      </Section>
      <Section title="Signals">
        <p className={styles.coverage}>
          <span className={styles.dots} aria-hidden="true">
            {signals.map((signal) => (
              <span key={signal.id} className={styles.dot} data-active={signal.active ? "" : undefined} title={signalMeta(signal.id).title} />
            ))}
          </span>
          <span>{`${active.length} of ${signals.length} signals active`}</span>
        </p>
        {inactive.map((signal) => (
          <p key={signal.id} className={styles.muted}>
            {`${signalMeta(signal.id).title}: needs ${signal.missing.join(", ")}`}
          </p>
        ))}
        {session.coverage.approximateJoins ? (
          <p className={styles.muted}>Approximate joins: this session was recorded before M1, so chapters link by time window.</p>
        ) : null}
        {session.gaps.length > 0 ? <p className={styles.muted}>{`${session.gaps.length} rows could not be read or paired`}</p> : null}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Related

/** Related is resolved lazily: refs are cheap ids; only the rows on screen are looked up (perf fix 4). */
type RelatedRef = { kind: "step"; id: StepId; asFinding?: Finding } | { kind: "chapter"; id: UnitStableId };

function resolveRef(session: TraceSession, index: TraceIndex, ref: RelatedRef): RelatedItem | null {
  const entry = index.entry(ref.id);
  if (ref.kind === "chapter") {
    const chapter = entry?.kind === "chapter" ? session.chapters[entry.position] : undefined;
    if (chapter === undefined) return null;
    return {
      id: chapter.id,
      icon: CATEGORY_ICON[chapter.category],
      title: displayUntrusted(chapter.title),
      tMs: chapter.tMs,
      graphic: null,
      shield: chapter.clampIds.length > 0,
    };
  }
  const step = entry?.kind === "step" ? session.steps[entry.position] : undefined;
  if (step === undefined) return null;
  if (ref.asFinding !== undefined) {
    return { id: step.id, icon: SIGNAL_ICON[ref.asFinding.ruleId], title: FINDING_TITLE[ref.asFinding.ruleId], tMs: step.tMs, graphic: null, shield: false };
  }
  const graphic = step.decision !== undefined || step.tests !== undefined ? pickGraphic(step, session) : null;
  const title = step.decision !== undefined ? displayUntrusted(step.decision.title) : displayUntrusted(step.headline);
  return { id: step.id, icon: KIND_ICON[step.kind], title, tMs: step.tMs, graphic, shield: false };
}

const decisionsCache = new WeakMap<TraceSession, { byTurn: Map<number, StepId[]>; byDecisionId: Map<string, StepId> }>();

function decisionsOf(session: TraceSession) {
  let cached = decisionsCache.get(session);
  if (cached === undefined) {
    cached = { byTurn: new Map(), byDecisionId: new Map() };
    for (const step of session.steps) {
      if (step.decision === undefined) continue;
      const list = cached.byTurn.get(step.turnIndex) ?? [];
      list.push(step.id);
      cached.byTurn.set(step.turnIndex, list);
      cached.byDecisionId.set(step.decision.decisionId, step.id);
    }
    decisionsCache.set(session, cached);
  }
  return cached;
}

function relatedRefsForStep(session: TraceSession, step: Step, own: readonly Finding[]): RelatedRef[] {
  const refs: RelatedRef[] = [];
  const seen = new Set<string>([step.id]);
  const add = (ref: RelatedRef): void => {
    if (seen.has(ref.id)) return;
    seen.add(ref.id);
    refs.push(ref);
  };
  // claim ↔ evidence: a step that a finding cites links back to the finding's anchor.
  for (const finding of citingFindingsOf(session, step)) add({ kind: "step", id: finding.anchorStepId, asFinding: finding });
  const claim = own.find((finding) => finding.ruleId === "claim_contradicted");
  if (claim !== undefined) {
    for (const id of decisionsOf(session).byTurn.get(step.turnIndex) ?? []) add({ kind: "step", id });
    for (const id of claim.chapterIds) add({ kind: "chapter", id });
  }
  for (const id of step.chapterIds) add({ kind: "chapter", id });
  return refs;
}

function relatedRefsForChapter(session: TraceSession, chapter: Chapter): RelatedRef[] {
  const refs: RelatedRef[] = [];
  const decisions = decisionsOf(session).byDecisionId;
  for (const id of chapter.decisionIds) {
    const stepId = decisions.get(id.slice("decision:".length));
    if (stepId !== undefined) refs.push({ kind: "step", id: stepId });
  }
  for (const id of chapter.validationStepIds) refs.push({ kind: "step", id });
  return refs;
}

function Related({
  refs,
  session,
  index,
  onSelect,
}: {
  refs: readonly RelatedRef[];
  session: TraceSession;
  index: TraceIndex;
  onSelect: Select;
}) {
  const [expanded, setExpanded] = useState(false);
  if (refs.length === 0) return null;
  const shown = refs.slice(0, expanded ? RELATED_MAX : RELATED_COLLAPSED);
  const items = shown.map((ref) => resolveRef(session, index, ref)).filter((item): item is RelatedItem => item !== null);
  const hidden = refs.length - shown.length;
  return (
    <Section title="Related">
      {items.map((item) => (
        <Row
          key={item.id}
          icon={item.icon}
          label={item.title}
          title={item.title}
          graphic={
            item.graphic !== null ? (
              <Graphic spec={item.graphic} size="xs" label={describeGraphic(item.graphic)} />
            ) : item.shield ? (
              <Icon name="shield" size={14} title="Guardrail" className={styles.icon} />
            ) : null
          }
          metric={formatOffset(item.tMs)}
          onClick={() => onSelect(item.id)}
        />
      ))}
      {hidden > 0 && !expanded ? (
        <button type="button" className={styles.more} onClick={() => setExpanded(true)}>
          {`${hidden.toLocaleString("en-US")} more`}
        </button>
      ) : null}
      {hidden > 0 && expanded ? <p className={styles.muted}>{`${hidden.toLocaleString("en-US")} more in the Outline`}</p> : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

export function Summary({ session, index, selection, onRelatedSelect }: SummaryProps) {
  const select = useSelect(onRelatedSelect);
  if (session === null) return <p className={styles.muted}>Loading the session</p>;
  if (selection === null) return <SessionSummary session={session} onSelect={select} />;
  const entry = index.entry(selection);
  if (entry?.kind === "chapter") {
    const chapter = session.chapters[entry.position];
    if (chapter === undefined) return <p className={styles.muted}>This chapter is not in the loaded range</p>;
    return (
      <>
        <ChapterDetails chapter={chapter} session={session} />
        <Related refs={relatedRefsForChapter(session, chapter)} session={session} index={index} onSelect={select} />
      </>
    );
  }
  const step = entry === undefined ? undefined : session.steps[entry.position];
  if (step === undefined) return <p className={styles.muted}>This step is not in the loaded range</p>;
  const own = findingsOf(session, step);
  const claim = own.find((finding) => finding.ruleId === "claim_contradicted");
  return (
    <>
      {own.map((finding, position) => (
        <FindingBlock key={finding.id} finding={finding} top={position === 0} />
      ))}
      {claim !== undefined ? (
        <ClaimEvidence finding={claim} step={step} session={session} index={index} onSelect={select} />
      ) : (
        <StepDetails step={step} session={session} onSelect={select} />
      )}
      <Related refs={relatedRefsForStep(session, step, own)} session={session} index={index} onSelect={select} />
    </>
  );
}
