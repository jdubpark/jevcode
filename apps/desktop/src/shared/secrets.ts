// apps/desktop/src/shared/secrets.ts
/** Settings page keys (spec 2026-10-04 settings and API keys). Shared by main and renderer: no Node imports. */
export const API_KEY_NAMES = ["ANTHROPIC_API_KEY", "TYPESAFE_API_KEY"] as const;
export type ApiKeyName = (typeof API_KEY_NAMES)[number];

export type KeySource = "app" | "env" | "none";

/** What the window may know about a key: never its value. */
export interface KeyStatus {
  name: ApiKeyName;
  set: boolean;
  source: KeySource;
  /** Last four characters of the active value, or null when none is active. */
  last4: string | null;
  /** A saved key is active and the environment also has one (the saved key overrides it). */
  envAlsoSet: boolean;
  /** A saved key exists but could not be decrypted. */
  unreadable: boolean;
}

export interface SecretsView {
  /** False when the OS cannot encrypt, so saving is refused. */
  canSave: boolean;
  /** secrets.json exists but could not be parsed. */
  fileUnreadable: boolean;
  keys: KeyStatus[];
}

export type KeyTestResult =
  | { result: "ok" }
  | { result: "unauthorized" }
  | { result: "unreachable" }
  | { result: "error"; status?: number };

export const API_KEY_MAX_LENGTH = 512;

/** Environment names read, in order, when no key is saved. */
export const ENV_FALLBACK: Record<ApiKeyName, readonly string[]> = {
  ANTHROPIC_API_KEY: ["ANTHROPIC_API_KEY"],
  TYPESAFE_API_KEY: ["TYPESAFE_API_KEY", "JEV_API_KEY"],
};

export const INVALID_KEY_MESSAGE = "A key must be 1 to 512 characters with no spaces or control characters.";
export const CANNOT_ENCRYPT_MESSAGE = "This system cannot encrypt saved keys; set the key in the environment instead.";

export function isApiKeyName(value: unknown): value is ApiKeyName {
  return typeof value === "string" && (API_KEY_NAMES as readonly string[]).includes(value);
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
const FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f]/u;

/** Trimmed value, or null when it is empty, too long, or holds whitespace or control characters. */
export function normalizeKeyValue(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > API_KEY_MAX_LENGTH || FORBIDDEN.test(value)) return null;
  return value;
}
