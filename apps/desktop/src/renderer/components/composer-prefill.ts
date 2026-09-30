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
