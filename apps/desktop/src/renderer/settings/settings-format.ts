import type { ApiKeyName, KeyStatus, KeyTestResult } from "../../shared/secrets.js";

export function keyTitle(name: ApiKeyName): string {
  return name === "ANTHROPIC_API_KEY" ? "Anthropic" : "TypeSafe";
}

export function keyPurpose(name: ApiKeyName): string {
  return name === "ANTHROPIC_API_KEY" ? "Narrator descriptions and stories" : "Jev decisions";
}

/** The TypeSafe key is read when a session starts; the Anthropic key applies at once (the narrator re-keys). */
export function keyAppliesNote(name: ApiKeyName): string | null {
  return name === "TYPESAFE_API_KEY" ? "Applies to new sessions" : null;
}

/** canSave: the OS can encrypt, so "save it again" is possible; otherwise the row offers only Remove. */
export function keyStatusLine(status: KeyStatus, canSave: boolean): string {
  if (status.unreadable && status.source !== "app") {
    const unreadable = canSave ? "A saved key could not be read; save it again" : "A saved key could not be read; remove it";
    return status.source === "env" ? `${unreadable} · using the environment key …${status.last4 ?? ""}` : unreadable;
  }
  switch (status.source) {
    case "app":
      return status.envAlsoSet
        ? `Saved in app · …${status.last4 ?? ""} — overrides the environment key`
        : `Saved in app · …${status.last4 ?? ""}`;
    case "env":
      return `From environment · …${status.last4 ?? ""}`;
    case "none":
      return "Not set";
  }
}

export function keyTestLine(result: KeyTestResult): string {
  switch (result.result) {
    case "ok":
      return "Key works";
    case "unauthorized":
      return "Anthropic rejected this key";
    case "unreachable":
      return "Could not reach Anthropic";
    case "error":
      return result.status === undefined ? "The check failed" : `The check failed (HTTP ${result.status})`;
  }
}

export function overrideNote(variable: string, value: string): string {
  return `Set by ${variable}=${value} (environment)`;
}
