// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { relativeAge } from "./relative-time.js";
import { RecentRepos } from "./RecentRepos.js";
import { SessionSwitcher } from "./SessionSwitcher.js";
import type { RepoOpenedPayload } from "../payload-types.js";
import { installFakeBridge, type FakeBridge } from "../test-support/fake-bridge.js";

const REPO: RepoOpenedPayload = { repoId: "r1", path: "/work/acme-web", gitRoot: "/work/acme-web", branch: "main", baseCommit: "abc" };
let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("sidebar rows (console-main mockup)", () => {
  it("tints only the open repository and renders names through displayUntrusted", async () => {
    vi.mocked(bridge.api.repo.listRecent).mockResolvedValue([
      { repoId: "r1", path: "/work/acme-web", name: "acme-web", branch: "main", lastOpenedAt: "2026-10-02T10:00:00.000Z" },
      { repoId: "r2", path: "/work/bill", name: "bill‮ing", branch: "main", lastOpenedAt: "2026-10-01T10:00:00.000Z" },
    ]);
    render(<RecentRepos selectedRepoId="r1" onSelect={() => undefined} />);
    const open = await screen.findByRole("button", { name: /acme-web/ });
    expect(open.className).toContain("on");
    const other = screen.getByRole("button", { name: /bill/ });
    expect(other.className).not.toContain("on");
    expect(other.textContent).toBe("bill⟨U+202E⟩ing");
  });

  it("lists sessions with a state icon, a relative age and a tinted active row", async () => {
    const now = Date.now();
    const ago = (ms: number): string => new Date(now - ms).toISOString();
    vi.mocked(bridge.api.repo.listSessions).mockResolvedValue([
      { sessionId: "s1", repoId: "r1", prompt: "Google OAuth login", state: "running", startedAt: ago(10_000) },
      { sessionId: "s2", repoId: "r1", prompt: "Rate limit the API", state: "completed", startedAt: ago(2 * 3_600_000) },
    ]);
    render(
      <SessionSwitcher
        repo={REPO}
        sessionState={{ sessionId: "s1", state: "running", changeUnitCount: 0, decisionCount: 0, ts: ago(0) }}
      />,
    );
    const active = await screen.findByRole("button", { name: /Google OAuth login/ });
    await waitFor(() => expect(active.textContent).toContain("now"));
    expect(active.className).toContain("on");
    expect(active.querySelector("svg")).not.toBeNull();
    const done = screen.getByRole("button", { name: /Rate limit the API/ });
    expect(done.className).not.toContain("on");
    expect(done.textContent).toContain("2 h");
  });

  it("formats ages", () => {
    const base = Date.parse("2026-10-02T12:00:00.000Z");
    expect(["2026-10-02T11:59:40.000Z", "2026-10-02T11:55:00.000Z", "2026-10-02T10:00:00.000Z", "2026-09-30T12:00:00.000Z"].map((iso) => relativeAge(iso, base))).toEqual(["now", "5 m", "2 h", "2 d"]);
  });
});
