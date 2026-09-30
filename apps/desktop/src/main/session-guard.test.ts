import { describe, expect, it } from "vitest";

import { openDb } from "@jevcode/storage";

import { IpcError } from "../shared/errors.js";
import { assertSessionInOpenRepo, stopSession } from "./session-service.js";

function createDb() {
  const db = openDb({ dbPath: `:memory:` });
  db.upsertRepository({ id: "repo_a", path: "/a", gitRoot: "/a" });
  db.createSession({ id: "sess_a", repoId: "repo_a", prompt: "demo" });
  return db;
}

describe("assertSessionInOpenRepo", () => {
  it("accepts a session of the open repo", () => {
    const db = createDb();
    expect(assertSessionInOpenRepo(db, "sess_a", "repo_a")).toEqual({
      sessionId: "sess_a",
      repoId: "repo_a",
    });
    db.close();
  });

  it("rejects an unknown session", () => {
    const db = createDb();
    try {
      assertSessionInOpenRepo(db, "sess_missing", "repo_a");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).code).toBe("UNKNOWN_SESSION");
    }
    db.close();
  });

  it("rejects a session from a different repo", () => {
    const db = createDb();
    db.upsertRepository({ id: "repo_b", path: "/b", gitRoot: "/b" });
    db.createSession({ id: "sess_b", repoId: "repo_b", prompt: "demo" });
    try {
      assertSessionInOpenRepo(db, "sess_b", "repo_a");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).code).toBe("NO_ACTIVE_SESSION");
    }
    db.close();
  });

  it("rejects when no repo is open", () => {
    const db = createDb();
    try {
      assertSessionInOpenRepo(db, "sess_a", null);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError);
      expect((error as IpcError).code).toBe("NO_ACTIVE_SESSION");
    }
    db.close();
  });
});

describe("stopSession terminal-state preservation", () => {
  it("keeps a failed session failed instead of rewriting it to completed", () => {
    const db = createDb();
    db.setSessionState("sess_a", "failed");
    const state = stopSession(db, "sess_a");
    expect(state.state).toBe("failed");
    expect(db.getSession("sess_a")?.state).toBe("failed");
    expect(db.getSession("sess_a")?.endedAt).not.toBeNull();
    db.close();
  });

  it("pauses a running session on stop and keeps its execution claim", () => {
    const db = createDb();
    db.setSessionState("sess_a", "running");
    db.setExecutionClaim("sess_a", "2026-09-28T10:00:00.000Z");
    const state = stopSession(db, "sess_a");
    expect(state.state).toBe("paused");
    expect(db.getSession("sess_a")?.state).toBe("paused");
    expect(db.getSession("sess_a")?.endedAt).toBeNull();
    expect(db.getSession("sess_a")?.executionClaimTs).toBe("2026-09-28T10:00:00.000Z");
    db.close();
  });

  it("keeps a session paused by the runtime paused", () => {
    const db = createDb();
    db.setSessionState("sess_a", "paused");
    expect(stopSession(db, "sess_a").state).toBe("paused");
    expect(db.getSession("sess_a")?.endedAt).toBeNull();
    db.close();
  });
});
