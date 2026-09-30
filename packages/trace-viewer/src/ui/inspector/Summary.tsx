import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  agentStateLabel,
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
  type Severity,
  type Step,
  type StepId,
  type TraceSession,
} from "../../model/index.js";
import { ClaimVsObserved } from "../graphics/ClaimVsObserved.js";
import { DiffBar } from "../graphics/DiffBar.js";
import { ForkGlyph } from "../graphics/ForkGlyph.js";
import { Graphic } from "../graphics/Graphic.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON } from "../icons/kind-icons.js";
import { displaySpanMs } from "../shell/TitleBar.js";
import { useDispatch } from "../state/store.js";
import { FINDING_TITLE, findingsOf } from "./finding-copy.js";
import styles from "./Inspector.module.css";

const SEVERITY_WORD: Record<Severity, string> = { critical: "Critical", warning: "Warning", info: "Info" };

export interface SummaryProps {
  /** Called when a Related click is about to change the selection (the Inspector then keeps focus). */
  onRelatedSelect?(): void;
  session: TraceSession | null;
  index: TraceIndex;
  selection: SelectionId | null;
}

interface RelatedItem {
  id: SelectionId;
  icon: IconName;
  title: string;
  tMs: number;
}

function ClaimText({ text, span }: { text: string; span: readonly [number, number] | undefined }) {
  if (span === undefined) return <p className={styles.prose}>{text}</p>;
  return (
    <p className={styles.prose}>
      {text.slice(0, span[0])}
      <span className={styles.claimSpan}>{text.slice(span[0], span[1])}</span>
      {text.slice(span[1])}
    </p>
  );
}

function FindingBlock({ finding }: { finding: Finding }) {
  const claim = finding.claim;
  return (
    <section className={styles.section} aria-label={FINDING_TITLE[finding.ruleId]}>
      <h3 className={styles.sectionTitle}>
        <span className={finding.severity === "critical" ? styles.badWord : undefined}>{SEVERITY_WORD[finding.severity]}</span>
        {` · ${signalMeta(finding.ruleId).title}`}
      </h3>
      <p className={styles.prose}>{finding.reason}</p>
      {claim === undefined ? null : (
        <ClaimVsObserved
          size="md"
          claim={{ text: claim.claim.text, span: finding.claimSpan, tMs: claim.claim.tMs }}
          observed={{
            passed: claim.observed.passed,
            failed: claim.observed.failed,
            command: displayUntrusted(normalizeCommand(claim.observed.command)),
            tMs: claim.observed.tMs,
          }}
        />
      )}
    </section>
  );
}

function CommandFacts({ step }: { step: Step }) {
  if (step.command === undefined) return null;
  return (
    <p className={styles.meta}>
      <span className={styles.path}>{displayUntrusted(normalizeCommand(step.command.command))}</span>
      {` · ${formatDuration(step.durationMs)}`}
      {exitLabel(step.command.exitCode) === "" ? "" : ` · ${exitLabel(step.command.exitCode)}`}
    </p>
  );
}

function claimSpanOf(session: TraceSession, step: Step): readonly [number, number] | undefined {
  return findingsOf(session, step).find((finding) => finding.ruleId === "claim_contradicted")?.claimSpan;
}

function StepDetails({ step, session }: { step: Step; session: TraceSession }) {
  const graphic = pickGraphic(step, session);
  const graphicNode = graphic === null ? null : <Graphic spec={graphic} size="md" label={describeGraphic(graphic)} />;
  if (step.tests !== undefined) {
    const tests = step.tests;
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{step.status === "failed" ? "Failing test" : "Test run"}</h3>
        {graphicNode}
        <p className={styles.counts}>
          <span>{`${tests.passed} passed`}</span>
          {tests.failed > 0 ? <span className={styles.badWord}>{`${tests.failed} failed`}</span> : null}
          {tests.skipped > 0 ? <span>{`${tests.skipped} skipped`}</span> : null}
        </p>
        {tests.failures.slice(0, 3).map((failure, position) => (
          <div key={`${failure.file}:${position}`} className={styles.failure}>
            <p className={styles.prose}>{displayUntrusted(failure.testName)}</p>
            <pre className={styles.mono}>{displayUntrusted(failure.message, { multiline: true })}</pre>
            <p className={styles.path}>{displayUntrusted(failure.file)}</p>
          </div>
        ))}
        {tests.failures.length > 3 ? <p className={styles.muted}>{`${tests.failures.length - 3} more`}</p> : null}
        <CommandFacts step={step} />
      </section>
    );
  }
  if (step.command !== undefined) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{KIND_META[step.kind].label}</h3>
        {graphicNode}
        <CommandFacts step={step} />
        {step.command.outputTail === undefined || step.command.outputTail === "" ? null : (
          <pre className={styles.mono}>{displayUntrusted(step.command.outputTail, { multiline: true })}</pre>
        )}
      </section>
    );
  }
  if (step.edit !== undefined) {
    const edit = step.edit;
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{KIND_META[step.kind].label}</h3>
        <p className={styles.path}>{displayUntrusted(edit.path)}</p>
        <DiffBar size="md" added={edit.added} removed={edit.removed} label={`+${edit.added} −${edit.removed}`} />
        <p className={styles.meta}>
          {`${edit.claimed ? "Agent reported" : "Not reported by the agent"} · ${
            edit.observed ? `Repo shows +${edit.added} −${edit.removed}` : "No repo change observed"
          }`}
        </p>
      </section>
    );
  }
  if (step.decision !== undefined) {
    const decision = step.decision;
    const chosen = decision.options.filter((option) => option.chosen).map((option) => option.label);
    const affected = session.chapters
      .filter((chapter) => chapter.decisionIds.some((id) => id.slice("decision:".length) === decision.decisionId))
      .map((chapter) => chapter.title);
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Decision</h3>
        <ForkGlyph
          size="md"
          options={decision.options.map((option) => ({ label: option.label, chosen: option.chosen }))}
          decidedBy={decision.decidedBy ?? "open"}
        />
        <ul className={styles.list}>
          {decision.options.map((option) => (
            <li key={option.id} className={option.chosen ? styles.chosen : undefined}>
              {option.label}
            </li>
          ))}
        </ul>
        <p className={styles.meta}>
          {chosen.length > 0 ? `Answer: ${chosen.join(", ")}` : "No answer yet"}
          {step.durationMs === null ? "" : ` · waited ${formatDuration(step.durationMs)}`}
        </p>
        {affected.length > 0 ? <p className={styles.meta}>{`Affects ${affected.map((title) => displayUntrusted(title)).join(", ")}`}</p> : null}
      </section>
    );
  }
  if (step.guardrail !== undefined) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Guardrails</h3>
        <ul className={styles.list}>
          {step.guardrail.clampIds.map((id) => (
            <li key={id}>{clampMeta(id).label}</li>
          ))}
        </ul>
        <p className={styles.meta}>{`${step.guardrail.clientKind} · confidence ${step.guardrail.confidence.toFixed(2)}`}</p>
      </section>
    );
  }
  if (step.text !== undefined) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{step.kind === "reasoning" ? "Thinking" : KIND_META[step.kind].label}</h3>
        <ClaimText text={step.text} span={claimSpanOf(session, step)} />
      </section>
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
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Chapter</h3>
      {graphic === null ? null : <Graphic spec={graphic} size="md" label={describeGraphic(graphic)} />}
      <ul className={styles.list}>
        {chapter.files.map((file) => (
          <li key={file} className={styles.path}>
            {displayUntrusted(file)}
          </li>
        ))}
      </ul>
      <p className={styles.meta}>
        {`${resolved} of ${cited} evidence links resolve${approx > 0 ? ` · ${approx} approximated` : ""}`}
      </p>
      {hasTriad ? (
        <>
          <h3 className={styles.sectionTitle}>{`Attention${chapter.triad.clientKind === undefined ? "" : ` · ${chapter.triad.clientKind}`}`}</h3>
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
        </>
      ) : null}
      {chapter.clampIds.length > 0 ? (
        <>
          <h3 className={styles.sectionTitle}>Guardrails</h3>
          <ul className={styles.list}>
            {chapter.clampIds.map((id) => (
              <li key={id}>{clampMeta(id).label}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function SessionSummary({ session }: { session: TraceSession }) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const finding of session.findings) counts[finding.severity] += 1;
  const signals = session.coverage.signals;
  const active = signals.filter((signal) => signal.active);
  const inactive = signals.filter((signal) => !signal.active);
  return (
    <section className={styles.section}>
      <p className={styles.prose}>{session.meta.prompt}</p>
      <p className={styles.meta}>{`${agentStateLabel(session.meta.state)} · ${formatDuration(displaySpanMs(session))}`}</p>
      {session.findings.length === 0 ? (
        <p className={styles.prose}>{`No problems found by ${active.length} signals`}</p>
      ) : (
        <p className={styles.prose}>
          {`${counts.critical} critical · ${counts.warning} warning · ${counts.info} info · n / N to step through`}
        </p>
      )}
      <p className={styles.meta}>{`${active.length} of ${signals.length} signals active`}</p>
      {inactive.length > 0 ? (
        <ul className={styles.list}>
          {inactive.map((signal) => (
            <li key={signal.id} className={styles.muted}>
              {`${signalMeta(signal.id).title}: needs ${signal.missing.join(", ")}`}
            </li>
          ))}
        </ul>
      ) : null}
      {session.coverage.approximateJoins ? (
        <p className={styles.muted}>Approximate joins: this session was recorded before M1, so chapters link by time window.</p>
      ) : null}
      {session.gaps.length > 0 ? (
        <p className={styles.muted}>{`${session.gaps.length} rows could not be read or paired`}</p>
      ) : null}
    </section>
  );
}

function Related({ items, onSelect }: { items: readonly RelatedItem[]; onSelect?(): void }) {
  const dispatch = useDispatch();
  if (items.length === 0) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Related</h3>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={styles.related}
          onClick={() => {
            onSelect?.();
            dispatch({ type: "select", id: item.id, by: "shell" });
          }}
        >
          <Icon name={item.icon} size={14} />
          <span>{item.title}</span>
          <span className={styles.relatedOffset}>{formatOffset(item.tMs)}</span>
        </button>
      ))}
    </section>
  );
}

function relatedForStep(session: TraceSession, step: Step): RelatedItem[] {
  const stepById = new Map<StepId, Step>(session.steps.map((item) => [item.id, item]));
  const items: RelatedItem[] = [];
  for (const finding of findingsOf(session, step)) {
    for (const id of finding.evidenceStepIds ?? []) {
      const evidence = stepById.get(id);
      if (evidence !== undefined) {
        items.push({ id: evidence.id, icon: KIND_ICON[evidence.kind], title: displayUntrusted(evidence.headline), tMs: evidence.tMs });
      }
    }
  }
  for (const chapterId of step.chapterIds) {
    const chapter = session.chapters.find((item) => item.id === chapterId);
    if (chapter !== undefined) items.push({ id: chapter.id, icon: CATEGORY_ICON[chapter.category], title: displayUntrusted(chapter.title), tMs: chapter.tMs });
  }
  return items;
}

function relatedForChapter(session: TraceSession, chapter: Chapter): RelatedItem[] {
  const items: RelatedItem[] = [];
  const decisionIds = new Set(chapter.decisionIds.map((id) => id.slice("decision:".length)));
  for (const step of session.steps) {
    const isDecision = step.decision !== undefined && decisionIds.has(step.decision.decisionId);
    if (isDecision || chapter.validationStepIds.includes(step.id)) {
      items.push({ id: step.id, icon: KIND_ICON[step.kind], title: displayUntrusted(step.headline), tMs: step.tMs });
    }
  }
  return items;
}

export function Summary({ session, index, selection, onRelatedSelect }: SummaryProps) {
  if (session === null) return <p className={styles.muted}>Loading the session</p>;
  if (selection === null) return <SessionSummary session={session} />;
  const entry = index.entry(selection);
  if (entry?.kind === "chapter") {
    const chapter = session.chapters[entry.position];
    if (chapter === undefined) return <p className={styles.muted}>This chapter is not in the loaded range</p>;
    return (
      <>
        <ChapterDetails chapter={chapter} session={session} />
        <Related items={relatedForChapter(session, chapter)} onSelect={onRelatedSelect} />
      </>
    );
  }
  const step = entry === undefined ? undefined : session.steps[entry.position];
  if (step === undefined) return <p className={styles.muted}>This step is not in the loaded range</p>;
  return (
    <>
      {findingsOf(session, step).map((finding) => (
        <FindingBlock key={finding.id} finding={finding} />
      ))}
      <StepDetails step={step} session={session} />
      <Related items={relatedForStep(session, step)} onSelect={onRelatedSelect} />
    </>
  );
}
