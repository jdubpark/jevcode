import type { AgentMode } from "./types.js";

const MODES: readonly string[] = ["codex", "mock", "auto", "replay"];

/** The session input or runtime option wins, then JEVC_AGENT, then the Settings page preference, then auto. */
export function chooseAgentMode(
  explicit: AgentMode | undefined,
  envValue: string | undefined,
  preference: AgentMode | undefined,
): AgentMode {
  if (explicit !== undefined) return explicit;
  if (envValue !== undefined && MODES.includes(envValue)) return envValue as AgentMode;
  return preference ?? "auto";
}
