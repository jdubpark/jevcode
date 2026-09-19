import { describe, expect, it } from "vitest";

import { openSessionDb, openTempDb } from "./test-utils.js";

describe("telemetry", () => {
  it("appends, lists, and exports telemetry events", () => {
    const db = openSessionDb();
    db.appendTelemetry("surface_shown", { specHash: "h1", confidence: 0.9 }, "sess_fixture");
    db.appendTelemetry("view_switched", { from: "summary", to: "diff" }, "sess_fixture");
    db.appendTelemetry("agent_event_count", { count: 42 });

    const events = db.listTelemetry();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type).sort()).toEqual([
      "agent_event_count",
      "surface_shown",
      "view_switched",
    ]);
    const surfaceShown = events.find((e) => e.type === "surface_shown");
    expect(surfaceShown?.payload).toEqual({ specHash: "h1", confidence: 0.9 });

    const scoped = db.listTelemetry({ sessionId: "sess_fixture" });
    expect(scoped).toHaveLength(2);

    const exported = db.exportTelemetry({ sessionId: "sess_fixture" });
    const parsed = JSON.parse(exported) as unknown[];
    expect(parsed).toHaveLength(2);
    const types = parsed
      .map((entry) => (entry as { type?: string }).type)
      .sort();
    expect(types).toEqual(["surface_shown", "view_switched"]);
    db.close();
  });

  it("allows sessionless telemetry (empty sessionId) and throws for unknown sessionIds", () => {
    const db = openSessionDb();
    db.appendTelemetry("surface_shown", { specHash: "h" });
    expect(db.listTelemetry()).toHaveLength(1);
    expect(() =>
      db.appendTelemetry("surface_shown", { specHash: "h" }, "sess_missing"),
    ).toThrow(/unknown sessionId/);
    db.close();
  });
});

describe("preferences", () => {
  it("sets, gets, overwrites, and lists preferences", () => {
    const db = openTempDb();
    db.setPreference("auto_collapse_passing_tests", true);
    db.setPreference("density", { level: "expert", nested: [1, 2, 3] });
    db.setPreference("auto_collapse_passing_tests", false);

    expect(db.getPreference("auto_collapse_passing_tests")).toBe(false);
    expect(db.getPreference("density")).toEqual({ level: "expert", nested: [1, 2, 3] });
    expect(db.getPreference("missing")).toBeUndefined();

    const prefs = db.listPreferences();
    expect(prefs).toHaveLength(2);
    const keys = prefs.map((p) => p.key).sort();
    expect(keys).toEqual(["auto_collapse_passing_tests", "density"]);
    db.close();
  });
});

describe("repositories and sessions", () => {
  it("upserts repositories and tracks recent order", () => {
    const db = openTempDb();
    db.upsertRepository({
      id: "repo_a",
      path: "/work/a",
      gitRoot: "/work/a",
      branch: "main",
      baseCommit: "abc",
    });
    db.upsertRepository({
      id: "repo_b",
      path: "/work/b",
      gitRoot: "/work/b",
      branch: "dev",
      baseCommit: "def",
    });
    db.upsertRepository({ path: "/work/a", gitRoot: "/work/a", branch: "main", baseCommit: "xyz" });

    const recent = db.listRecentRepositories();
    expect(recent.map((r) => r.path)).toEqual(["/work/a", "/work/b"]);
    expect(recent[0]?.baseCommit).toBe("xyz");
    expect(db.findRepositoryByPath("/work/a")?.baseCommit).toBe("xyz");
    expect(db.getRepository("repo_a")?.baseCommit).toBe("xyz");
    db.close();
  });

  it("creates sessions, lists them, and updates state", () => {
    const db = openTempDb();
    db.upsertRepository({ id: "repo_a", path: "/work/a", gitRoot: "/work/a" });
    const s1 = db.createSession({
      repoId: "repo_a",
      prompt: "add rate limiting",
      baseCommit: "abc",
      branch: "main",
    });
    const s2 = db.createSession({ repoId: "repo_a", prompt: "fix oauth" });

    expect(s1.state).toBe("starting");
    expect(db.getSession(s1.id)?.prompt).toBe("add rate limiting");

    db.setSessionState(s1.id, "running");
    db.setSessionPrompt(s2.id, "fix oauth flow");
    db.setSessionEnded(s2.id);

    const sessions = db.listSessions("repo_a");
    expect(sessions).toHaveLength(2);
    expect(db.getSession(s1.id)?.state).toBe("running");
    const ended = db.getSession(s2.id);
    expect(ended?.prompt).toBe("fix oauth flow");
    expect(ended?.endedAt).not.toBeNull();
    db.close();
  });
});
