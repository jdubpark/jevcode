export interface DestructivePattern {
  name: string;
  pattern: RegExp;
}

export const destructivePatterns: readonly DestructivePattern[] = [
  {
    name: "rm-recursive-force",
    pattern:
      /\brm\b\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r)\b/i,
  },
  {
    name: "rm-recursive-force-long",
    pattern: /\brm\b\s+(?=.*--recursive)(?=.*--force)/i,
  },
  {
    name: "git-push-force",
    pattern: /\bgit\s+push\b[^\n]*(^|\s)(--force|-f)(\s|$)/,
  },
  { name: "git-reset-hard", pattern: /\bgit\s+reset\s+--hard\b/ },
  { name: "sql-drop-table", pattern: /\bDROP\s+TABLE\b/i },
  { name: "sql-truncate", pattern: /\bTRUNCATE(\s+TABLE)?\b/i },
  { name: "sql-delete-from", pattern: /\bDELETE\s+FROM\b/i },
  { name: "db-reset", pattern: /\bdb:reset\b/i },
  {
    name: "migration-down",
    pattern:
      /\b(migrat(?:e|ion)s?\s+(down|rollback)|migrate:down|migration:down|db:migrate:down|knex migrate:down)\b/i,
  },
];

export function matchDestructive(command: string): DestructivePattern | null {
  for (const entry of destructivePatterns) {
    if (entry.pattern.test(command)) return entry;
  }
  return null;
}

export function classifyDestructive(command: string): boolean {
  return matchDestructive(command) !== null;
}

export const isDestructiveCommand = classifyDestructive;
