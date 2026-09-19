import { describe, expect, it } from "vitest";

import {
  classifyDestructive,
  destructivePatterns,
  matchDestructive,
} from "./destructive.js";

describe("destructivePatterns", () => {
  it("covers all SPEC 8.3.1 pattern classes", () => {
    const names = destructivePatterns.map((p) => p.name);
    for (const expected of [
      "rm-recursive-force",
      "git-push-force",
      "git-reset-hard",
      "sql-drop-table",
      "sql-truncate",
      "sql-delete-from",
      "db-reset",
      "migration-down",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each([
    "rm -rf /tmp/build",
    "sudo rm -rf /var/cache",
    "rm -fr node_modules",
    "rm -r -f dist",
    "rm --recursive --force build",
    "git push --force origin main",
    "git push origin -f",
    "git push -f",
    "git reset --hard HEAD~1",
    "DROP TABLE users",
    "drop table users",
    "TRUNCATE TABLE sessions",
    "TRUNCATE sessions",
    "DELETE FROM users WHERE id = 1",
    "pnpm db:reset",
    "rails db:reset",
    "knex migrate:down",
    "npm run migrate down",
    "prisma migrate down",
  ])("flags %s as destructive", (command) => {
    expect(classifyDestructive(command)).toBe(true);
  });

  it.each([
    "rm file.txt",
    "rm -r dist",
    "rm -f file.txt",
    "git push origin main",
    "git push --force-with-lease origin main",
    "git reset --soft HEAD~1",
    "git reset HEAD~1",
    "SELECT * FROM drop_table",
    "TRUNCATED output",
    "db:migrate:up",
    "npm run migrate up",
    "git status",
    "pnpm test",
  ])("does not flag %s", (command) => {
    expect(classifyDestructive(command)).toBe(false);
  });

  it("returns the matched pattern name", () => {
    expect(matchDestructive("git reset --hard HEAD")?.name).toBe("git-reset-hard");
    expect(matchDestructive("rm -rf out")?.name).toBe("rm-recursive-force");
    expect(matchDestructive("pnpm db:reset")?.name).toBe("db-reset");
    expect(matchDestructive("git status")).toBeNull();
  });
});
