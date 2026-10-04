import type { ApiKeyName, KeyStatus, KeyTestResult } from "../../shared/secrets.js";

export function keyTitle(name: ApiKeyName): string {
  return name === "ANTHROPIC_API_KEY" ? "Anthropic" : "TypeSafe";
}

export function keyPurpose(name: ApiKeyName): string {
  return name === "ANTHROPIC_API_KEY" ? "Narrator descriptions and stories" : "Jev decisions";
}

export function keyStatusLine(status: KeyStatus): string {
  if (status.unreadable && status.source !== "app") {
    return status.source === "env"
      ? `A saved key could not be read; save it again · using the environment key …${status.last4 ?? ""}`
      : "A saved key could not be read; save it again";
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
