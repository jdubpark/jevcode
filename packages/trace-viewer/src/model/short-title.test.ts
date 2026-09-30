import { describe, expect, it } from "vitest";

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
});
