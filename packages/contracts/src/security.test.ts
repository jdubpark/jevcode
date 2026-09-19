import { describe, expect, it } from "vitest";

import {
  classifyDestructive,
  destructivePatterns,
  isDestructiveCommand,
  matchDestructive,
} from "./security.js";

describe("destructivePatterns", () => {
  it("declares one named pattern per SPEC 8.3.1 entry", () => {
    expect(destructivePatterns.map((entry) => entry.name)).toEqual([
      "rm-recursive-force",
      "rm-recursive-force-long",
      "git-push-force",
      "git-reset-hard",
      "sql-drop-table",
      "sql-truncate",
      "sql-delete-from",
      "db-reset",
      "migration-down",
    ]);
  });
});

describe("SPEC 8.3.1 patterns", () => {
  const destructive = [
    "rm -rf node_modules",
    "rm -Rf node_modules",
    "rm -RF node_modules",
    "rm -rF build",
    "rm -fr build",
    "rm -r -f build",
    "rm -f -r build",
    "rm --recursive --force build",
    "git push --force origin main",
    "git push -f",
    "git push origin main -f",
    "git reset --hard HEAD~1",
    "DROP TABLE users",
    "drop table users",
    "TRUNCATE sessions",
    "TRUNCATE TABLE sessions",
    "DELETE FROM users WHERE id = 1",
    "delete from users",
    "pnpm db:reset",
    "prisma migrate down",
    "knex migrate:down",
    "db:migrate:down",
  ];
  const safe = [
    "rm README.md",
    "rm -f /tmp/cache.db",
    "rm -r src/old",
    "rm -i file.txt",
    "git push --force-with-lease origin main",
    "git push origin main",
    "git reset HEAD~1",
    "git reset --soft HEAD~1",
    "npm test",
    "prisma migrate up",
    "npm run migrate:rollback-docs",
    "NOTRUNCATE sessions",
  ];

  it.each(destructive)("flags %s", (command) => {
    expect(classifyDestructive(command), command).toBe(true);
    expect(isDestructiveCommand(command), command).toBe(true);
  });

  it.each(safe)("does not flag %s", (command) => {
    expect(classifyDestructive(command), command).toBe(false);
    expect(isDestructiveCommand(command), command).toBe(false);
  });

  it("names the matching pattern", () => {
    expect(matchDestructive("rm -rf out")?.name).toBe("rm-recursive-force");
    expect(matchDestructive("rm -Rf out")?.name).toBe("rm-recursive-force");
    expect(matchDestructive("git push --force")?.name).toBe("git-push-force");
    expect(matchDestructive("git push --force-with-lease")).toBeNull();
    expect(matchDestructive("git reset --hard HEAD")?.name).toBe("git-reset-hard");
    expect(matchDestructive("DROP TABLE users")?.name).toBe("sql-drop-table");
    expect(matchDestructive("TRUNCATE sessions")?.name).toBe("sql-truncate");
    expect(matchDestructive("DELETE FROM users")?.name).toBe("sql-delete-from");
    expect(matchDestructive("pnpm db:reset")?.name).toBe("db-reset");
    expect(matchDestructive("prisma migrate down")?.name).toBe("migration-down");
    expect(matchDestructive("git status")).toBeNull();
  });

  it("keeps isDestructiveCommand as the classifyDestructive alias", () => {
    expect(isDestructiveCommand).toBe(classifyDestructive);
  });
});
