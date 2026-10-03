import type { JSX } from "react";

import type { BriefDecisionCard } from "../../layout/brief-decisions.js";
import { displayUntrusted, truncateMiddle } from "../../model/index.js";
import { ForkGlyph } from "../graphics/ForkGlyph.js";
import { Icon } from "../icons/Icon.js";
import { useSessionView } from "../shell/session-context.js";
import { useDispatch } from "../state/store.js";
import type { AnswerState } from "../views/console/ConsoleRowView.js";
import { narratorNote } from "../views/map/map-text.js";
import { CitationChips } from "./CitationChips.js";
import styles from "./explainer.module.css";

/** Component chip labels clip here; the tooltip carries the whole name. */
const COMPONENT_LABEL_MAX = 24;

export interface DecisionCardProps {
  card: BriefDecisionCard;
  /** Present only where the host can answer (the main window); the trace window shows no buttons. */
  onAnswer?(optionId: string): void;
  /** Where this card's answer stands (the Brief keeps it by decision id, as the Console does). Default "idle". */
  answer?: AnswerState;
}

const ASK: Readonly<Record<AnswerState, string>> = {
  idle: "Needs your decision",
  sending: "Sending answer",
  sent: "Answer sent",
  failed: "Could not send the answer. Try again.",
};

/** "Fail open · chosen by you" (the H3 mockup); a delegated decision names the agent. */
function decidedLine(card: BriefDecisionCard): string {
  const chosen = card.options.filter((option) => option.chosen).map((option) => displayUntrusted(option.label));
  if (card.decidedBy === "delegated") return chosen.length === 0 ? "Delegated to the agent" : `${chosen.join(", ")} · chosen by the agent`;
  return chosen.length === 0 ? "Answered by you" : `${chosen.join(", ")} · chosen by you`;
}

/**
 * Spec §3.5: the question, the options with their tradeoffs as a fork, the choice and who chose it, the narrator's why
 * with its citations, and the components it affected. A pending card sits on the accent tint with its options and, where
 * the host answers, a Choose button per option; a decided card is neutral and shows the choice and the why. Every agent
 * or narrator string goes through displayUntrusted, with the full text in the tooltip and the accessible name.
 */
export function DecisionCard({ card, onAnswer, answer = "idle" }: DecisionCardProps): JSX.Element {
  const dispatch = useDispatch();
  const overview = useSessionView().session?.overview ?? null;
  // Ruling R3: no why yet reads as the narrator state ("Descriptions off" / "unavailable" / "pending"), never an alert.
  const quietWhy = (overview === null ? null : narratorNote(overview)) ?? "No explanation yet";
  const title = displayUntrusted(card.title);
  const open = card.status === "open";
  // An answer on its way or sent takes no second one: the runtime would reject it (the Console's rule, V-4 fix round 1).
  const locked = answer === "sending" || answer === "sent";
  const why = card.why;
  const whyText = why === null ? null : displayUntrusted(why.text);
  return (
    <section className={styles.card} aria-label={`Decision card: ${title}`} data-status={card.status}>
      <div className={styles.cardHead}>
        <Icon name="fork" size={14} className={styles.icon} />
        <button
          type="button"
          className={styles.question}
          title={title}
          onClick={() => dispatch({ type: "select", id: card.stepId, by: "shell" })}
        >
          {title}
        </button>
        <span className={styles.fork}>
          <ForkGlyph
            size="sm"
            options={card.options.map((option) => ({ label: displayUntrusted(option.label), chosen: option.chosen }))}
            decidedBy={card.decidedBy}
          />
        </span>
      </div>
      {open ? (
        <p className={styles.ask} data-answer={answer}>
          {ASK[answer]}
        </p>
      ) : (
        <p className={styles.by}>{decidedLine(card)}</p>
      )}
      {open ? (
        <ul className={styles.options}>
          {card.options.map((option) => {
            const label = displayUntrusted(option.label);
            const tradeoffs = option.tradeoffs.map((t) => `${displayUntrusted(t.dimension)}: ${displayUntrusted(t.consequence)}`);
            // Lane 03 rejects an empty answer: a blank option id never becomes a Choose button.
            const answerable = onAnswer !== undefined && option.id.trim() !== "";
            return (
              <li key={option.id} className={styles.option}>
                <span className={styles.optionLabel} title={label}>
                  {label}
                </span>
                {tradeoffs.length === 0 ? null : (
                  <span className={styles.tradeoff} title={tradeoffs.join("\n")}>
                    {tradeoffs.length > 1 ? `${tradeoffs[0]} · +${tradeoffs.length - 1}` : tradeoffs[0]}
                  </span>
                )}
                {answerable ? (
                  <button
                    type="button"
                    className={styles.answer}
                    aria-label={`Choose ${label}`}
                    disabled={locked}
                    onClick={() => {
                      if (!locked) onAnswer(option.id);
                    }}
                  >
                    Choose
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : why !== null && whyText !== null ? (
        <p className={styles.why}>
          <Icon name="jev" size={12} className={styles.icon} />
          <span>
            <span title={whyText}>{whyText}</span>
            <CitationChips citations={why.citations} />
          </span>
        </p>
      ) : (
        <p className={`${styles.why} ${styles.quiet}`}>
          <Icon name="jev" size={12} className={styles.icon} />
          <span>{quietWhy}</span>
        </p>
      )}
      {card.components.length === 0 ? null : (
        <div className={styles.components} aria-label="Affected components">
          {card.components.map((component) => (
            <button
              key={component.id}
              type="button"
              className={styles.chip}
              title={displayUntrusted(component.name)}
              aria-label={displayUntrusted(component.name)}
              onClick={() => {
                dispatch({ type: "view/switch", view: "map" });
                dispatch({ type: "map/select", componentId: component.id });
              }}
            >
              <Icon name="stack" size={12} className={styles.icon} />
              <span className={styles.chipLabel}>{truncateMiddle(component.name, COMPONENT_LABEL_MAX)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
