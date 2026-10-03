import { createAnthropicNarratorTransport, createNarratorClient } from "@jevcode/jev-router";
import type { NarratorClient } from "@jevcode/jev-router";

import type { NarratorAvailability } from "../../shared/narrator-log.js";

export const NARRATOR_API_KEY_ENV = "ANTHROPIC_API_KEY";
/** "off" disables every narrator call regardless of the setting. */
export const NARRATOR_KILL_ENV = "JEVCODE_NARRATOR";

export interface NarratorSwitch {
  current(): NarratorClient | null;
  availability(): NarratorAvailability;
  setEnabled(enabled: boolean): void;
  /** Called when the client or the availability changes; read `availability()` for the reason. */
  subscribe(listener: (client: NarratorClient | null) => void): () => void;
}

export interface NarratorSwitchOptions {
  enabled: boolean;
  env: Readonly<Record<string, string | undefined>>;
  createClient?: (apiKey: string) => NarratorClient;
}

export function narratorAvailability(
  enabled: boolean,
  env: Readonly<Record<string, string | undefined>>,
): NarratorAvailability {
  if ((env[NARRATOR_KILL_ENV] ?? "").trim().toLowerCase() === "off") return "off_env";
  if (!enabled) return "off_setting";
  if ((env[NARRATOR_API_KEY_ENV] ?? "").trim() === "") return "off_no_key";
  return "on";
}

/** Spec E15: the explainWithModel setting (and a key) decide whether any narrator call can happen. */
export function createNarratorSwitch(options: NarratorSwitchOptions): NarratorSwitch {
  const createClient =
    options.createClient ?? ((apiKey: string) => createNarratorClient(createAnthropicNarratorTransport({ apiKey })));
  let enabled = options.enabled;
  let client: NarratorClient | null = null;
  const listeners = new Set<(client: NarratorClient | null) => void>();

  const resolve = (): NarratorClient | null => {
    if (narratorAvailability(enabled, options.env) !== "on") return null;
    client ??= createClient((options.env[NARRATOR_API_KEY_ENV] ?? "").trim());
    return client;
  };

  return {
    current: resolve,
    availability: () => narratorAvailability(enabled, options.env),
    setEnabled(next) {
      if (next === enabled) return;
      const before = { client: resolve(), availability: narratorAvailability(enabled, options.env) };
      enabled = next;
      const after = resolve();
      // Without a key the client stays null, but the reason changes (status.narrator "unavailable" vs "off", R3).
      if (after === before.client && narratorAvailability(enabled, options.env) === before.availability) return;
      for (const listener of listeners) listener(after);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
