export const ICON_NAMES = [
  "person", "bubble", "thought", "plug", "term", "test", "gauge", "edit", "eye", "key", "fork", "pkg", "undo", "flag", "jev",
  "neq", "quote", "shield", "table", "route", "list", "stack", "eyeoff",
  "cursor", "hand", "fit", "zoom", "search", "clock", "check", "chev-d", "chev-r", "live", "copy", "reply", "diff", "file",
  "view-canvas", "view-hybrid", "view-console", "view-map", "view-surfaces", "brief",
  "role-ui", "role-api", "role-agent", "role-domain", "role-storage", "role-tooling", "role-config", "fan-in",
] as const;
export type IconName = (typeof ICON_NAMES)[number];
