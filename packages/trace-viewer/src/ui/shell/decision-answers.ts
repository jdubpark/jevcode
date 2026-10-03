import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";

import { useViewerHost } from "./host-context.js";
import type { ViewerHost } from "./host.js";
import { useAnnounce } from "./LiveRegion.js";

/** Where the reader's answer to a pending decision stands (spec §3.2 Console block, §3.5 Brief card). */
export type AnswerState = "idle" | "sending" | "sent" | "failed";

type Send = NonNullable<ViewerHost["answerDecision"]>;

/**
 * One viewer's answers, by decision id, shared by every surface that answers (the Console's decision block and the
 * Brief's cards) and kept for the viewer's life, so a surface that unmounts (the Brief, whenever the Inspector shows)
 * comes back knowing an answer is on its way or sent. An answer sending or sent takes no second one: the runtime
 * rejects it (pipeline-runtime UNKNOWN_DECISION) until the trace shows the decision answered.
 */
export interface DecisionAnswerStore {
  /** The current states; a new map object on every change. */
  snapshot(): ReadonlyMap<string, AnswerState>;
  subscribe(listener: () => void): () => void;
  /**
   * Sends `optionId` through `send` unless the decision's answer is sending or sent, or the option id is blank (lane 03
   * rejects an empty answer). Resolves to the state the attempt ended in, or null when nothing was sent.
   */
  answer(decisionId: string, optionId: string, send: Send): Promise<AnswerState> | null;
}

const NO_ANSWERS: ReadonlyMap<string, AnswerState> = new Map();

export function createDecisionAnswerStore(): DecisionAnswerStore {
  let states: ReadonlyMap<string, AnswerState> = NO_ANSWERS;
  const listeners = new Set<() => void>();
  const set = (decisionId: string, state: AnswerState): void => {
    states = new Map(states).set(decisionId, state);
    for (const listener of [...listeners]) listener();
  };
  return {
    snapshot: () => states,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    answer(decisionId, optionId, send) {
      const current = states.get(decisionId);
      if (optionId.trim() === "" || current === "sending" || current === "sent") return null;
      set(decisionId, "sending");
      let sent: Promise<void>;
      try {
        sent = Promise.resolve(send({ decisionId, optionId }));
      } catch (error) {
        sent = Promise.reject(error);
      }
      return sent.then(
        () => {
          set(decisionId, "sent");
          return "sent" as const;
        },
        () => {
          set(decisionId, "failed");
          return "failed" as const;
        },
      );
    },
  };
}

/** The viewer's store (the Shell provides one per viewer, the test harness one per harness). */
export const DecisionAnswersContext = createContext<DecisionAnswerStore | null>(null);

export interface DecisionAnswers {
  states: ReadonlyMap<string, AnswerState>;
  /** The host answers decisions (the main window); the trace window does not. */
  canAnswer: boolean;
  /** Answers through the host and announces how it went. Does nothing without a host action or while one is on its way. */
  answer(decisionId: string, optionId: string): void;
}

/** The shared answers for a surface. Outside a provider (a component rendered alone) the surface keeps its own store. */
export function useDecisionAnswers(): DecisionAnswers {
  const provided = useContext(DecisionAnswersContext);
  const [own] = useState(createDecisionAnswerStore);
  const store = provided ?? own;
  const states = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const host = useViewerHost();
  const announce = useAnnounce();
  const send = host.answerDecision;
  const answer = useCallback(
    (decisionId: string, optionId: string): void => {
      if (send === undefined) return;
      void store
        .answer(decisionId, optionId, (request) => send.call(host, request))
        ?.then((state) => announce(state === "sent" ? "Answer sent" : "Could not send the answer"));
    },
    [store, host, send, announce],
  );
  return { states, canAnswer: send !== undefined, answer };
}
