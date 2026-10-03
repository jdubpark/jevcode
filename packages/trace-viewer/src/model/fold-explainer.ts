import type { ExplainerRecord, NarrativeSentence } from "@jevcode/contracts";

import { HIGHLIGHT_STATES, type ExplainerModel, type HighlightEntryModel, type HighlightsModel, type StoryModel } from "./types.js";

// Explainer rows are append-local (spec §8.1): they never touch steps, turns or chapters, so the
// incremental finalize needs no derived state for them. The output object is cached until a row
// changes the fold state, so unchanged finalizes return the same ExplainerModel.

export interface ExplainerFoldState {
  story: StoryModel | null;
  readonly stories: StoryModel[];
  /** The finalize's copy of `stories`, kept until a story row adds a refresh (the Console merges on its identity). */
  storiesOut: readonly StoryModel[] | null;
  readonly why: Map<string, NarrativeSentence>;
  highlights: HighlightsModel | null;
  out: ExplainerModel | null;
}

export function createExplainerFoldState(): ExplainerFoldState {
  return { story: null, stories: [], storiesOut: null, why: new Map(), highlights: null, out: null };
}

function copySentence(sentence: NarrativeSentence): NarrativeSentence {
  return { text: sentence.text, citations: sentence.citations.map((citation) => ({ kind: citation.kind, id: citation.id })) };
}

function sameSentences(a: readonly NarrativeSentence[], b: readonly NarrativeSentence[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function foldExplainer(state: ExplainerFoldState, record: ExplainerRecord, seq: number): void {
  switch (record.kind) {
    case "story": {
      const current = state.story;
      if (current !== null && record.basisSeq < current.basisSeq) return;
      const next: StoryModel = {
        sentences: record.sentences.map(copySentence),
        basisSeq: record.basisSeq,
        seq,
        provenance: record.provenance ?? "model",
      };
      if (current === null || !sameSentences(current.sentences, next.sentences)) {
        state.stories.push(next);
        state.storiesOut = null;
      }
      state.story = next;
      break;
    }
    case "decision_why":
      state.why.set(record.decisionId, copySentence(record.sentence));
      break;
    case "highlights": {
      const current = state.highlights;
      if (current !== null && record.basisSeq < current.basisSeq) return;
      const byComponent = new Map<string, HighlightEntryModel>();
      for (const entry of record.components) byComponent.set(entry.id, {
          state: entry.state,
          states: entry.states === undefined ? [entry.state] : HIGHLIGHT_STATES.filter((state) => entry.states?.includes(state)),
          unitIds: [...entry.unitIds],
        });
      state.highlights = { basisSeq: record.basisSeq, seq, byComponent };
      break;
    }
  }
  state.out = null;
}

/** The finalize's view; the same object until the next folded explainer row changes something. */
export function explainerModelOf(state: ExplainerFoldState): ExplainerModel {
  if (state.out === null) {
    state.storiesOut ??= [...state.stories];
    state.out = { story: state.story, stories: state.storiesOut, decisionWhy: new Map(state.why), highlights: state.highlights };
  }
  return state.out;
}
