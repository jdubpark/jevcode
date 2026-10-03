import type { Citation } from "@jevcode/contracts";
import type { JSX } from "react";

import { resolveCitation, sessionStep, type StepKind, type TraceSession } from "../../model/index.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { useSessionView } from "../shell/session-context.js";
import { useDispatch } from "../state/store.js";
import styles from "./explainer.module.css";

const CHIP_ICON: Readonly<Record<Citation["kind"], IconName>> = {
  step: "list",
  decision: "fork",
  file: "edit",
  component: "stack",
  fact: "quote",
};

/** A cited step reads as what it is (the mockup's test run and narrative quote); other steps as a log line. */
const STEP_ICON: Partial<Record<StepKind, IconName>> = { test: "test", check: "test", command: "term", edit: "edit", decision: "fork" };

function iconOf(session: TraceSession, citation: Citation, stepId: string | null): IconName {
  if (citation.kind !== "step" || stepId === null) return CHIP_ICON[citation.kind];
  const kind = sessionStep(session, stepId)?.kind;
  return (kind === undefined ? undefined : STEP_ICON[kind]) ?? CHIP_ICON.step;
}

/**
 * Citation chips (spec §3.3). A chip only selects what it names or opens the Map; it never runs an action. A citation
 * this trace cannot resolve, a fact citation among them (lane 07 alignment note), is plain text with no action.
 */
export function CitationChips({ citations }: { citations: readonly Citation[] }): JSX.Element | null {
  const { session } = useSessionView();
  const dispatch = useDispatch();
  if (session === null || citations.length === 0) return null;
  return (
    <span className={styles.chips}>
      {citations.map((citation, index) => {
        const target = resolveCitation(session, citation);
        const key = `${citation.kind}:${citation.id}:${index}`;
        const icon = <Icon name={iconOf(session, citation, target.kind === "select" ? target.id : null)} size={12} className={styles.icon} />;
        if (target.kind === "none") {
          return (
            <span key={key} className={styles.chipOff} title={target.full} aria-label={`${target.label}, not in this trace`}>
              {icon}
              <span className={styles.chipLabel}>{target.label}</span>
            </span>
          );
        }
        const open = (): void => {
          if (target.kind === "select") {
            dispatch({ type: "select", id: target.id, by: "shell" });
            return;
          }
          dispatch({ type: "view/switch", view: "map" });
          dispatch({ type: "map/select", componentId: target.componentId });
        };
        return (
          <button key={key} type="button" className={styles.chip} title={target.full} aria-label={`Open ${target.full}`} onClick={open}>
            {icon}
            <span className={styles.chipLabel}>{target.label}</span>
          </button>
        );
      })}
    </span>
  );
}
