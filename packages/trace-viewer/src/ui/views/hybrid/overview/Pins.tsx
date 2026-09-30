import { LANE_H, PIN_PX, type PinPlacement } from "../../../../layout/overview-layout.js";
import type { SelectionId } from "../../../../layout/trace-index.js";
import { formatOffset, KIND_META, type Step, type TraceSession } from "../../../../model/index.js";
import { FINDING_TITLE, topFindingOf } from "../../../inspector/finding-copy.js";
import type { IconName } from "../../../icons/icon-names.js";
import { Icon } from "../../../icons/Icon.js";
import { KIND_ICON, SIGNAL_ICON } from "../../../icons/kind-icons.js";
import styles from "./Overview.module.css";
import { laneTop } from "./paint.js";

/** Spike risk 5 ruling (C2-0): true paints pins on the canvas and keeps these buttons as focus targets. */
export const PINS_PAINTED_ON_CANVAS = false;

export function pinIcon(pin: PinPlacement, session: TraceSession): IconName {
  const finding = pin.findingId === null ? undefined : session.findings.find((item) => item.id === pin.findingId);
  if (finding !== undefined) return finding.ruleId === "claim_contradicted" ? "quote" : SIGNAL_ICON[finding.ruleId];
  switch (pin.kind) {
    case "decision":
      return "fork";
    case "approval":
      return "key";
    case "instruction":
      return "person";
    case "guardrail":
      return "shield";
    default: {
      const step = session.steps[pin.stepIndexes[0] ?? -1];
      return step === undefined ? "flag" : KIND_ICON[step.kind];
    }
  }
}

/** Pin names are viewer chrome: a finding title or the kind label, never agent-derived text (spec "Untrusted agent text" row). */
function pinTitle(session: TraceSession, step: Step): string {
  const finding = topFindingOf(session, step);
  return finding === null ? KIND_META[step.kind].label : FINDING_TITLE[finding.ruleId];
}

export function pinLabel(pin: PinPlacement, session: TraceSession): string {
  const steps = pin.stepIndexes.map((position) => session.steps[position]).filter((step): step is Step => step !== undefined);
  if (pin.cluster) {
    const problems = steps.filter((step) => step.problems.length > 0 || step.findingIds.length > 0).length;
    const range = `${formatOffset(steps[0]?.tMs ?? 0)} to ${formatOffset(steps.at(-1)?.tMs ?? 0)}`;
    return `${steps.length} events, ${range}${problems > 0 ? `, ${problems} ${problems === 1 ? "problem" : "problems"}` : ""}`;
  }
  const step = steps[0];
  return step === undefined ? "Pin" : `${pinTitle(session, step)}, ${formatOffset(step.tMs)}`;
}

export interface PinsProps {
  pins: readonly PinPlacement[];
  session: TraceSession;
  selection: SelectionId | null;
  onSelect(stepIndex: number): void;
  onZoomTo(stepIndexes: readonly number[]): void;
}

export function Pins({ pins, session, selection, onSelect, onZoomTo }: PinsProps) {
  return (
    <>
      {pins.map((pin) => {
        const selected = pin.stepIndexes.some((position) => session.steps[position]?.id === selection);
        return (
          <button
            key={pin.key}
            type="button"
            tabIndex={-1}
            data-overlay-node=""
            data-steps={pin.stepIndexes.join(",")}
            data-critical={pin.critical ? "" : undefined}
            data-painted={PINS_PAINTED_ON_CANVAS ? "" : undefined}
            aria-pressed={selected}
            aria-label={pinLabel(pin, session)}
            className={styles.pin}
            style={{ left: pin.x - PIN_PX / 2, top: laneTop(pin.lane) + (LANE_H - PIN_PX) / 2 }}
            onClick={() => {
              if (pin.cluster) onZoomTo(pin.stepIndexes);
              else if (pin.stepIndexes[0] !== undefined) onSelect(pin.stepIndexes[0]);
            }}
          >
            {pin.cluster ? (
              <span className={styles.pinCount}>{pin.stepIndexes.length}</span>
            ) : (
              <Icon name={pinIcon(pin, session)} size={14} />
            )}
          </button>
        );
      })}
    </>
  );
}
