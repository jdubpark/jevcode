/** A trace window's review note (composer:prefill, spec §8.5). */
export interface ComposerPrefill {
  sessionId: string;
  text: string;
}

export type PrefillDecision =
  | { kind: "apply"; draft: string }
  | { kind: "notice"; sessionId: string };

/** "" → text; else the draft without trailing newlines + "\n" + text. A draft of only newlines counts as empty. */
export function appendPrefill(draft: string, text: string): string {
  const head = draft.replace(/\n+$/, "");
  return head.length === 0 ? text : `${head}\n${text}`;
}

/**
 * The note joins the composer only when the main window shows its session.
 * Otherwise the workspace shows "Trace note for another session · Switch";
 * switching stays the user's explicit action.
 */
export function decidePrefill(
  activeSessionId: string | null,
  payload: ComposerPrefill,
  draft: string,
): PrefillDecision {
  if (activeSessionId !== null && activeSessionId === payload.sessionId) {
    return { kind: "apply", draft: appendPrefill(draft, payload.text) };
  }
  return { kind: "notice", sessionId: payload.sessionId };
}

/**
 * The draft after a successful send. Only the sent text is removed: a review
 * note appended while the send was in flight stays in the composer.
 */
export function clearSent(draft: string, sent: string): string {
  if (draft === sent) return "";
  const head = sent.replace(/\n+$/, "");
  if (head.length > 0 && draft.startsWith(`${head}\n`)) {
    return draft.slice(head.length).replace(/^\n+/, "");
  }
  return draft;
}

export interface HeldNote {
  note: ComposerPrefill;
  /** True when this note replaced a different held note, so the notice can say so. */
  replaced: boolean;
}

export interface ComposerState {
  /** The session whose draft `draft` belongs to. */
  sessionId: string | null;
  draft: string;
  /** A note for another session, waiting for the user's own switch. Latest only. */
  held: HeldNote | null;
  /**
   * True from a user action that should focus the composer until the view
   * focuses it (`focusDone`). The textarea is disabled during a send, so the
   * request outlives that send instead of being lost.
   */
  focusPending: boolean;
}

export type ComposerEvent =
  | { type: "edit"; draft: string }
  | { type: "prefill"; payload: ComposerPrefill }
  | { type: "sessionChanged"; sessionId: string | null }
  | { type: "sent"; text: string }
  | { type: "dismiss" }
  | { type: "focusDone" };

export function initialComposer(sessionId: string | null): ComposerState {
  return { sessionId, draft: "", held: null, focusPending: false };
}

function withNote(draft: string, text: string): string {
  const head = draft.replace(/\n+$/, "");
  // The same note pressed twice must not duplicate.
  if (head === text || head.endsWith(`\n${text}`)) return draft;
  return appendPrefill(draft, text);
}

/** Draft and held-note lifecycle for the workspace composer (spec §8.5). */
export function composerReducer(state: ComposerState, event: ComposerEvent): ComposerState {
  switch (event.type) {
    case "edit":
      return { ...state, draft: event.draft };
    case "prefill": {
      const { payload } = event;
      if (state.sessionId !== null && payload.sessionId === state.sessionId) {
        return { ...state, draft: withNote(state.draft, payload.text), focusPending: true };
      }
      const prior = state.held?.note;
      if (prior !== undefined && prior.sessionId === payload.sessionId && prior.text === payload.text) {
        return state;
      }
      return { ...state, held: { note: payload, replaced: prior !== undefined } };
    }
    case "sessionChanged": {
      if (event.sessionId === state.sessionId) return state;
      const base = { ...state, sessionId: event.sessionId, draft: "" };
      const held = state.held;
      if (held !== null && event.sessionId !== null && held.note.sessionId === event.sessionId) {
        return { ...base, draft: held.note.text, held: null, focusPending: true };
      }
      return base;
    }
    case "sent":
      return { ...state, draft: clearSent(state.draft, event.text) };
    case "dismiss":
      return { ...state, held: null };
    case "focusDone":
      return state.focusPending ? { ...state, focusPending: false } : state;
  }
}
