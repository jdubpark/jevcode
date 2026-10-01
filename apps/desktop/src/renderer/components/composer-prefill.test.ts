import { describe, expect, it } from "vitest";

import { appendPrefill, clearSent, composerReducer, decidePrefill, initialComposer, traceNoteTarget } from "./composer-prefill.js";

const NOTE = 'Re: trace s1 +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)\n> all checks pass';

describe("appendPrefill", () => {
  it("uses the note as the whole draft when the composer is empty", () => {
    expect(appendPrefill("", "x")).toBe("x");
    expect(appendPrefill("\n\n", "x")).toBe("x");
  });

  it("keeps the draft and appends on a new line", () => {
    expect(appendPrefill("a\n\n", "x")).toBe("a\nx");
    expect(appendPrefill("Please also add a test", NOTE)).toBe(`Please also add a test\n${NOTE}`);
    expect(appendPrefill("  indented draft  ", "x")).toBe("  indented draft  \nx");
  });

  it("leaves bidi and control characters in the note untouched", () => {
    const note = "Re: ‮evil‬ `a‏b`";
    expect(appendPrefill("", note)).toBe(note);
  });
});

describe("decidePrefill", () => {
  it("applies a note for the active session to the draft", () => {
    expect(decidePrefill("s1", { sessionId: "s1", text: NOTE }, "draft")).toEqual({
      kind: "apply",
      draft: `draft\n${NOTE}`,
    });
  });

  it("a note for another session becomes a notice and leaves the draft alone", () => {
    expect(decidePrefill("s1", { sessionId: "s2", text: NOTE }, "draft")).toEqual({
      kind: "notice",
      sessionId: "s2",
    });
    expect(decidePrefill(null, { sessionId: "s2", text: NOTE }, "")).toEqual({
      kind: "notice",
      sessionId: "s2",
    });
  });
});

describe("clearSent", () => {
  it("clears a draft that still equals the sent text", () => {
    expect(clearSent("fix it", "fix it")).toBe("");
    expect(clearSent("fix it\n", "fix it\n")).toBe("");
  });

  it("keeps a note appended after the sent text", () => {
    expect(clearSent(`fix it\n${NOTE}`, "fix it")).toBe(NOTE);
    expect(clearSent(`fix it\n${NOTE}`, "fix it\n")).toBe(NOTE);
  });

  it("keeps an unrelated draft unchanged", () => {
    expect(clearSent("something else", "fix it")).toBe("something else");
    expect(clearSent("fix items", "fix it")).toBe("fix items");
  });
});

describe("composerReducer", () => {
  const start = initialComposer("s1");
  const note = (sessionId: string, text = "note") => ({ sessionId, text });

  it("appends a note for the active session and requests focus", () => {
    const next = composerReducer(
      composerReducer(start, { type: "edit", draft: "draft" }),
      { type: "prefill", payload: note("s1") },
    );
    expect(next.draft).toBe("draft\nnote");
    expect(next.focusPending).toBe(true);
    expect(next.held).toBeNull();
  });

  it("holds a note for another session and applies it after the switch", () => {
    const edited = composerReducer(start, { type: "edit", draft: "old draft" });
    const held = composerReducer(edited, { type: "prefill", payload: note("s2") });
    expect(held.draft).toBe("old draft");
    expect(held.held?.note).toEqual(note("s2"));
    const switched = composerReducer(held, { type: "sessionChanged", sessionId: "s2" });
    expect(switched.draft).toBe("note");
    expect(switched.held).toBeNull();
    expect(switched.focusPending).toBe(true);
  });

  it("keeps the held note when the session changes to a third session", () => {
    const held = composerReducer(start, { type: "prefill", payload: note("s2") });
    const other = composerReducer(held, { type: "sessionChanged", sessionId: "s3" });
    expect(other.draft).toBe("");
    expect(other.held?.note).toEqual(note("s2"));
  });

  it("dismiss drops the held note", () => {
    const held = composerReducer(start, { type: "prefill", payload: note("s2") });
    const next = composerReducer(held, { type: "dismiss" });
    expect(next.held).toBeNull();
    expect(composerReducer(next, { type: "sessionChanged", sessionId: "s2" }).draft).toBe("");
  });

  it("a newer held note replaces the older one and is flagged as a replacement", () => {
    const first = composerReducer(start, { type: "prefill", payload: note("s2", "a") });
    expect(first.held?.replaced).toBe(false);
    const second = composerReducer(first, { type: "prefill", payload: note("s3", "b") });
    expect(second.held).toEqual({ note: note("s3", "b"), replaced: true });
  });

  it("keeps a note that arrives while an instruction send is in flight", () => {
    const sending = composerReducer(start, { type: "edit", draft: "fix it" });
    const withNote = composerReducer(sending, { type: "prefill", payload: note("s1", NOTE) });
    const after = composerReducer(withNote, { type: "sent", text: "fix it" });
    expect(after.draft).toBe(NOTE);
  });

  it("keeps the focus request from a note that arrived during a send until the view consumes it", () => {
    const sending = composerReducer(start, { type: "edit", draft: "fix it" });
    const withNote = composerReducer(sending, { type: "prefill", payload: note("s1", NOTE) });
    const after = composerReducer(withNote, { type: "sent", text: "fix it" });
    expect(after.focusPending).toBe(true);
    const consumed = composerReducer(after, { type: "focusDone" });
    expect(consumed.focusPending).toBe(false);
    expect(consumed.draft).toBe(NOTE);
  });

  it("requests no focus for edits, sends, dismissals or a held note", () => {
    const edited = composerReducer(start, { type: "edit", draft: "fix it" });
    expect(edited.focusPending).toBe(false);
    expect(composerReducer(edited, { type: "sent", text: "fix it" }).focusPending).toBe(false);
    const held = composerReducer(start, { type: "prefill", payload: note("s2") });
    expect(held.focusPending).toBe(false);
    expect(composerReducer(held, { type: "dismiss" }).focusPending).toBe(false);
  });

  it("clears the draft when nothing arrived during the send", () => {
    const sending = composerReducer(start, { type: "edit", draft: "fix it" });
    expect(composerReducer(sending, { type: "sent", text: "fix it" }).draft).toBe("");
  });

  it("the same note twice does not duplicate", () => {
    const once = composerReducer(start, { type: "prefill", payload: note("s1", NOTE) });
    const twice = composerReducer(once, { type: "prefill", payload: note("s1", NOTE) });
    expect(twice.draft).toBe(NOTE);
    const withDraft = composerReducer(
      composerReducer(start, { type: "edit", draft: "mine" }),
      { type: "prefill", payload: note("s1", NOTE) },
    );
    expect(composerReducer(withDraft, { type: "prefill", payload: note("s1", NOTE) }).draft).toBe(
      `mine\n${NOTE}`,
    );
  });

  it("the same held note twice is not flagged as a replacement", () => {
    const first = composerReducer(start, { type: "prefill", payload: note("s2") });
    const again = composerReducer(first, { type: "prefill", payload: note("s2") });
    expect(again.held?.replaced).toBe(false);
  });
});

describe("traceNoteTarget", () => {
  it("names the session by its prompt on one line, cut in the middle", () => {
    expect(traceNoteTarget("Add a rate limiter", "sess_1")).toBe("Add a rate limiter");
    expect(traceNoteTarget("Add a\n  rate   limiter", "sess_1")).toBe("Add a rate limiter");
    const long = traceNoteTarget(`Start ${"x".repeat(200)} end`, "sess_1");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.startsWith("Start")).toBe(true);
    expect(long.endsWith("end")).toBe(true);
  });

  it("shows bidi controls in a prompt as visible tokens", () => {
    expect(traceNoteTarget("fix \u202Eevil", "sess_1")).toBe("fix ⟨U+202E⟩evil");
  });

  it("falls back to the session id when the prompt is unknown or blank", () => {
    expect(traceNoteTarget(undefined, "sess_abc")).toBe("sess_abc");
    expect(traceNoteTarget("  \n ", "sess_abc")).toBe("sess_abc");
    expect(traceNoteTarget(undefined, "s".repeat(80)).length).toBeLessThanOrEqual(48);
  });
});
