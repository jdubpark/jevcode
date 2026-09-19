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
});
