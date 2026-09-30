import type { ComponentType } from "react";

import type { TraceIndex } from "../../../../../layout/trace-index.js";
import { stepTone } from "../../../../../layout/tone.js";
import {
  describeGraphic,
  displayUntrusted,
  exitLabel,
  formatDuration,
  formatOffset,
  normalizeCommand,
  pickGraphic,
  truncateMiddle,
  type Finding,
  type FindingId,
  type GraphicSpec,
  type Step,
  type StepId,
  type StepKind,
  type TraceSession,
} from "../../../../../model/index.js";
import { FINDING_TITLE, topFindingOf } from "../../../../inspector/finding-copy.js";
import { Graphic } from "../../../../graphics/Graphic.js";
import { Icon } from "../../../../icons/Icon.js";
import { KIND_ICON, SIGNAL_ICON } from "../../../../icons/kind-icons.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

/** Spec §7.6.3 ROW_GRAPHIC: which kinds show a graphic in the 120 px slot. */
const ROW_GRAPHIC: { readonly [K in StepKind]: GraphicSpec["kind"] | null } = {
  instruction: null,
  message: null,
  reasoning: null,
  lifecycle: null,
  read: null,
  approval: null,
  guardrail: null,
  attention: null,
  command: "duration",
  tool: "duration",
  check: "duration",
  test: "tests",
  edit: "diff",
  dependency: "diff",
  revert: "diff",
  decision: "fork",
};

export interface StepRowProps {
  step: Step;
  session: TraceSession;
  index: TraceIndex;
  findingsById: ReadonlyMap<FindingId, Finding>;
  expanded: boolean;
  selected: boolean;
  playhead: boolean;
  matched: boolean;
  hourGutter: boolean;
  /** Epoch ms on the source clock (originMs + nowT()); running bars grow to it. */
  nowMs: number;
  FindingBody: ComponentType<FindingBodyProps> | null;
  onSelect(): void;
  onToggle(): void;
  onJump(stepId: StepId): void;
}

/** First line of agent prose, with bidi and control characters made visible. */
function firstLine(text: string): string {
  return displayUntrusted(text.split("\n")[0] ?? "");
}

function lineOf(step: Step): { text: string; mono: boolean; className?: string } {
  if (step.command !== undefined) return { text: displayUntrusted(normalizeCommand(step.command.command)), mono: true };
  if (step.edit !== undefined) return { text: truncateMiddle(displayUntrusted(step.edit.path), 64), mono: true };
  if (step.decision !== undefined) return { text: step.decision.title, mono: false };
  if (step.kind === "reasoning") return { text: `Thinking ${firstLine(step.text ?? "")}`, mono: false, className: "thinking" };
  if (step.kind === "message") return { text: firstLine(step.text ?? step.headline), mono: false, className: "message" };
  if (step.kind === "instruction") return { text: firstLine(step.text ?? step.headline), mono: false };
  return { text: displayUntrusted(step.headline), mono: false };
}

function metricOf(step: Step): string {
  if (step.tests !== undefined) {
    const total = step.tests.passed + step.tests.failed + step.tests.skipped;
    return `${step.tests.passed}/${total}${step.durationMs === null ? "" : ` · ${formatDuration(step.durationMs)}`}`;
  }
  if (step.edit !== undefined) return `+${step.edit.added} −${step.edit.removed}`;
  if (step.command !== undefined) {
    const exit = step.command.exitCode;
    if (exit !== null && exit !== 0) return exitLabel(exit);
    return formatDuration(step.durationMs);
  }
  if (step.guardrail !== undefined) return step.guardrail.clampIds.join(", ");
  return "";
}

export function StepRow(props: StepRowProps) {
  const { step, session, findingsById, expanded, selected, playhead, matched, hourGutter, nowMs, FindingBody } = props;
  const finding = topFindingOf(session, step);
  const critical = finding?.severity === "critical";
  const tone = stepTone(step, findingsById);
  const graphicKind = ROW_GRAPHIC[step.kind];
  const picked = graphicKind === null ? null : pickGraphic(step, session);
  const graphic = picked !== null && picked.kind === graphicKind ? picked : null;
  // A running duration bar grows to now (lane hand-off M-1); Step.startMs is epoch ms.
  const elapsedMs = graphic !== null && graphic.kind === "duration" && graphic.running ? Math.max(0, nowMs - step.startMs) : undefined;
  const exitX = step.command !== undefined && step.command.exitCode !== null && step.command.exitCode > 0 && step.kind === "command";
  const line = lineOf(step);
  return (
    <>
      <div
        className={styles.row}
        data-selected={selected ? "" : undefined}
        data-match={matched ? "" : undefined}
        data-hour={hourGutter ? "" : undefined}
        data-expanded={expanded ? "" : undefined}
        onClick={props.onSelect}
      >
        <span className={styles.time} data-playhead={playhead ? "" : undefined}>
          {formatOffset(step.tMs)}
        </span>
        <span className={styles.node} data-tone={critical ? "critical" : tone === "bad" ? "bad" : "neutral"}>
          <Icon name={KIND_ICON[step.kind]} size={14} />
          {exitX ? (
            <span className={styles.nodeX} aria-hidden="true">
              ✕
            </span>
          ) : null}
        </span>
        <span className={styles.graphic}>
          {graphic === null ? null : <Graphic spec={graphic} size="xs" label={describeGraphic(graphic)} elapsedMs={elapsedMs} />}
        </span>
        {finding === null ? (
          <span className={`${styles.line} ${line.mono ? styles.mono : ""} ${line.className === undefined ? "" : styles[line.className] ?? ""}`}>
            {line.text}
          </span>
        ) : (
          <span className={`${styles.line} ${critical ? styles.findingTitle : ""}`}>{FINDING_TITLE[finding.ruleId]}</span>
        )}
        <span className={styles.metric} data-tone={tone === "bad" ? "bad" : "neutral"}>
          {metricOf(step)}
          {finding !== null && !critical ? <Icon name={SIGNAL_ICON[finding.ruleId]} size={12} title={FINDING_TITLE[finding.ruleId]} /> : null}
          {finding === null ? null : (
            <button
              type="button"
              tabIndex={-1}
              className={styles.chevron}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse finding" : "Expand finding"}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggle();
              }}
            >
              <Icon name={expanded ? "chev-d" : "chev-r"} size={12} />
            </button>
          )}
        </span>
      </div>
      {expanded && finding !== null && FindingBody !== null ? (
        <div className={styles.body}>
          <FindingBody finding={finding} step={step} session={session} onJump={props.onJump} />
        </div>
      ) : null}
    </>
  );
}
