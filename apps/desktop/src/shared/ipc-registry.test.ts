import { describe, expect, it } from "vitest";

import { IpcError } from "./errors.js";
import { parseFromMain, parseToMain } from "./ipc-registry.js";

describe("ipc channel registry", () => {
  it("validates contract channels renderer to main", () => {
    expect(parseToMain("repo:open", { path: "/work/repo" })).toEqual({
      path: "/work/repo",
    });
    expect(parseToMain("session:start", { repoId: "r1", prompt: "hi" })).toEqual({
      repoId: "r1",
      prompt: "hi",
    });
    expect(
      parseToMain("terminal:input", { sessionId: "s1", data: "ls\r" }),
    ).toEqual({ sessionId: "s1", data: "ls\r" });
  });

  it("rejects unknown toMain channels with a typed error", () => {
    expect(() => parseToMain("nope:channel", {})).toThrowError(IpcError);
    try {
      parseToMain("nope:channel", {});
    } catch (error) {
      expect(error).toMatchObject({ code: "UNKNOWN_CHANNEL" });
    }
  });

  it("rejects invalid payloads with a typed error", () => {
    expect(() => parseToMain("repo:open", {})).toThrowError(IpcError);
    expect(() => parseToMain("repo:open", { path: "" })).toThrowError(IpcError);
    try {
      parseToMain("session:start", { repoId: "r1" });
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_PAYLOAD" });
    }
  });

  it("validates local channels renderer to main", () => {
    expect(parseToMain("repo:browse", {})).toEqual({});
    expect(parseToMain("repo:listRecent", { limit: 5 })).toEqual({ limit: 5 });
    expect(parseToMain("session:switch", { sessionId: "s1" })).toEqual({
      sessionId: "s1",
    });
    expect(
      parseToMain("terminal:getScrollback", { sessionId: "s1", maxLines: 100 }),
    ).toEqual({ sessionId: "s1", maxLines: 100 });
  });

  it("validates contract channels main to renderer", () => {
    const opened = parseFromMain("repo:opened", {
      repoId: "r1",
      path: "/work/repo",
      gitRoot: "/work/repo",
      branch: "main",
      baseCommit: "abc123",
    });
    expect(opened).toMatchObject({ repoId: "r1", branch: "main" });
    expect(parseFromMain("terminal:data", { sessionId: "s1", data: "x" })).toEqual({
      sessionId: "s1",
      data: "x",
    });
  });

  it("rejects unknown and invalid fromMain channels", () => {
    expect(() => parseFromMain("nope:channel", {})).toThrowError(IpcError);
    expect(() =>
      parseFromMain("repo:opened", { repoId: "r1", branch: 42 }),
    ).toThrowError(IpcError);
  });

  it("validates local channels main to renderer", () => {
    const payload = parseFromMain("repo:recentRepos", {
      repositories: [
        {
          repoId: "r1",
          path: "/work/repo",
          name: "repo",
          branch: "main",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(payload.repositories).toHaveLength(1);
  });

  it("carries model and approvalMode through the session:start override", () => {
    const payload = parseToMain("session:start", {
      repoId: "r1",
      prompt: "hi",
      model: "gpt-5",
      approvalMode: "on-failure",
    });
    expect(payload).toEqual({
      repoId: "r1",
      prompt: "hi",
      model: "gpt-5",
      approvalMode: "on-failure",
    });
    expect(() =>
      parseToMain("session:start", {
        repoId: "r1",
        prompt: "hi",
        approvalMode: "always",
      }),
    ).toThrowError(IpcError);
  });

  it("bounds the read-only trace channels", () => {
    expect(parseToMain("trace:listSessions", {})).toEqual({});
    expect(parseToMain("trace:listSessions", { repoId: "r1", limit: 500 })).toEqual({
      repoId: "r1",
      limit: 500,
    });
    expect(parseToMain("trace:listSessions", { sessionId: "s", limit: 1 })).toEqual({
      sessionId: "s",
      limit: 1,
    });
    expect(parseToMain("trace:rows", { sessionId: "s", afterSeq: 0, limit: 5000 })).toEqual({
      sessionId: "s",
      afterSeq: 0,
      limit: 5000,
    });
    expect(parseToMain("trace:payloads", { sessionId: "s", seqs: [1, 2] })).toEqual({
      sessionId: "s",
      seqs: [1, 2],
    });
    const rejected: Array<[string, unknown]> = [
      ["trace:listSessions", { limit: 501 }],
      ["trace:listSessions", { repoId: "" }],
      ["trace:listSessions", { sessionId: "" }],
      ["trace:rows", { sessionId: "s", limit: 5001 }],
      ["trace:rows", { sessionId: "", afterSeq: 0 }],
      ["trace:rows", { sessionId: "s", afterSeq: -1 }],
      ["trace:rows", { sessionId: "s", afterSeq: 1.5 }],
      ["trace:payloads", { sessionId: "s", seqs: [] }],
      ["trace:payloads", { sessionId: "s", seqs: Array.from({ length: 51 }, (_, i) => i + 1) }],
      ["trace:payloads", { sessionId: "s", seqs: [0] }],
    ];
    for (const [channel, payload] of rejected) {
      let caught: unknown;
      try {
        parseToMain(channel, payload);
      } catch (error) {
        caught = error;
      }
      expect(caught, `${channel} ${JSON.stringify(payload).slice(0, 60)}`).toBeInstanceOf(IpcError);
      expect(caught).toMatchObject({ code: "INVALID_PAYLOAD" });
    }
  });
});

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof IpcError ? error.code : "not an IpcError";
  }
  return undefined;
}

describe("trace window channels", () => {
  it("accepts trace:open, trace:requestChanges and composer:prefill", () => {
    expect(parseToMain("trace:open", { sessionId: "s1" })).toEqual({ sessionId: "s1" });
    for (const selected of ["step:48", "unit:u1", "decision:dec-oauth-0001"]) {
      expect(
        parseToMain("trace:requestChanges", { sessionId: "s1", selected, text: "Re: trace s1" }),
      ).toEqual({ sessionId: "s1", selected, text: "Re: trace s1" });
    }
    expect(
      parseToMain("trace:requestChanges", {
        sessionId: "s1",
        selected: "step:1",
        text: "a".repeat(8_000),
      }),
    ).toMatchObject({ selected: "step:1" });
    expect(parseFromMain("composer:prefill", { sessionId: "s1", text: "note" })).toEqual({
      sessionId: "s1",
      text: "note",
    });
  });

  it("rejects empty, oversized and non-step trace window payloads", () => {
    const rejected: Array<[string, unknown]> = [
      ["trace:open", {}],
      ["trace:open", { sessionId: "" }],
      ["trace:requestChanges", { sessionId: "s1", selected: "step:48", text: "" }],
      ["trace:requestChanges", { sessionId: "s1", selected: "step:48", text: "a".repeat(8_001) }],
      ["trace:requestChanges", { sessionId: "s1", selected: "file:src/a.ts", text: "x" }],
      ["trace:requestChanges", { sessionId: "s1", selected: "step:abc", text: "x" }],
      ["trace:requestChanges", { sessionId: "", selected: "step:48", text: "x" }],
    ];
    for (const [channel, payload] of rejected) {
      expect(codeOf(() => parseToMain(channel, payload)), `${channel} ${JSON.stringify(payload).slice(0, 60)}`).toBe(
        "INVALID_PAYLOAD",
      );
    }
    expect(
      codeOf(() => parseFromMain("composer:prefill", { sessionId: "s1", text: "a".repeat(8_001) })),
    ).toBe("INVALID_PAYLOAD");
  });
});
