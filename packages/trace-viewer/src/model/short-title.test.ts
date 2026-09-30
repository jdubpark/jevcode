import { describe, expect, it } from "vitest";

import { displayUntrusted } from "./format.js";
import { chapterShortTitle, isPlaceholderTitle } from "./short-title.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeCount = (text: string): number => Array.from(segmenter.segment(text)).length;

describe("chapterShortTitle (orchestrator ruling M2)", () => {
  // semantic-core's buildPlaceholderTitle: "Changed N file(s): <first three files>" or "Changed 0 files".
  const placeholder = (files: string[]) =>
    files.length === 0 ? "Changed 0 files" : `Changed ${files.length} ${files.length === 1 ? "file" : "files"}: ${files.slice(0, 3).join(", ")}`;
  const short = (category: Parameters<typeof chapterShortTitle>[0]["category"], files: string[], title = placeholder(files)) =>
    chapterShortTitle({ title, category, files });

  it("recognises only the placeholder shape", () => {
    expect(isPlaceholderTitle("Changed 1 file: package.json")).toBe(true);
    expect(isPlaceholderTitle("Changed 12 files: a.ts, b.ts, c.ts")).toBe(true);
    expect(isPlaceholderTitle("Changed 0 files")).toBe(true);
    expect(isPlaceholderTitle("Changed the login flow")).toBe(false);
    expect(isPlaceholderTitle("Google OAuth identity layer")).toBe(false);
  });

  it("names a placeholder chapter by its category and focus file stem", () => {
    expect(short("dependency", ["package.json"])).toBe("Package");
    expect(short("schema", ["migrations/001_create_identities.sql"])).toBe("Migration · identities");
    expect(short("tests", ["tests/auth/oauth.test.ts"])).toBe("Tests · oauth");
    expect(short("implementation", ["src/db/users.ts"])).toBe("Code · users");
    expect(short("implementation", ["pnpm-lock.yaml"])).toBe("Lockfile");
    expect(short("security", ["pnpm-lock.yaml", "src/auth/google.ts", "src/auth/session.ts"])).toBe("Security · google");
    expect(short("documentation", [])).toBe("Docs");
  });

  it("stays within 24 graphemes", () => {
    const long = short("schema", ["migrations/002_add_really_long_column_names_everywhere.sql"]);
    expect(graphemeCount(long)).toBeLessThanOrEqual(24);
    expect(long.startsWith("Migration · ")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
  });

  it("trims a real title to its first clause, cut at a word", () => {
    expect(short("configuration", [], "Account-linking policy for existing users signing in through Google is unspecified.")).toBe(
      "Account-linking policy…",
    );
    expect(short("security", [], "Auth architecture changed: User -> Identity -> Session, with OAuth")).toBe("Auth architecture…");
    expect(short("tests", [], "  Linking test  ")).toBe("Linking test");
    for (const title of ["Google OAuth identity layer", "identities table migration", "OAuth account-linking test failure"]) {
      expect(graphemeCount(short("implementation", [], title))).toBeLessThanOrEqual(24);
    }
  });

  it("never turns a control character into a space or trims it away (lane review I-1)", () => {
    // A \r, \v or \f is shown as a visible token at render time; whitespace folding must not erase it first.
    expect(short("tests", [], "Fix\rlogin flow")).toBe("Fix\rlogin flow");
    expect(short("tests", [], "Fix login\u000B")).toBe("Fix login\u000B");
    expect(short("tests", [], "\u000CFix login")).toBe("\u000CFix login");
    expect(displayUntrusted(short("tests", [], "Fix\rlogin flow"))).toBe("Fix\u27E8U+000D\u27E9login flow");
  });

  it("keeps a bidi control whole when the cut lands next to it, so its display token is never cut", () => {
    const title = `${"x".repeat(22)}\u202E${"y".repeat(10)}`;
    const cut = short("tests", [], title);
    expect(cut).toBe(`${"x".repeat(22)}\u202E…`);
    expect(displayUntrusted(cut)).toBe(`${"x".repeat(22)}\u27E8U+202E\u27E9…`);
    // A clause break is a real space, not a control: a colon followed by \r does not end the clause there.
    expect(short("tests", [], "Auth flow:\rrm -rf")).toBe("Auth flow:\rrm -rf");
  });
});
