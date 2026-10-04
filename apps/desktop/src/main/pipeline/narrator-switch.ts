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
  /** Re-reads the active key (Settings page save or remove); notifies when the client or availability changed. */
  refresh(): void;
  /** Called when the client or the availability changes; read `availability()` for the reason. */
  subscribe(listener: (client: NarratorClient | null) => void): () => void;
}

export interface NarratorSwitchOptions {
  enabled: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** The active Anthropic key (secrets store: saved, else environment). Absent: env.ANTHROPIC_API_KEY. */
  apiKey?: () => string | null;
  createClient?: (apiKey: string) => NarratorClient;
}

export function narratorAvailability(
  enabled: boolean,
  env: Readonly<Record<string, string | undefined>>,
  apiKey?: string | null,
): NarratorAvailability {
  if ((env[NARRATOR_KILL_ENV] ?? "").trim().toLowerCase() === "off") return "off_env";
  if (!enabled) return "off_setting";
  const key = apiKey === undefined ? (env[NARRATOR_API_KEY_ENV] ?? "") : (apiKey ?? "");
  if (key.trim() === "") return "off_no_key";
  return "on";
}

/** Spec E15: the explainWithModel setting (and a key) decide whether any narrator call can happen. */
export function createNarratorSwitch(options: NarratorSwitchOptions): NarratorSwitch {
  const createClient =
    options.createClient ?? ((apiKey: string) => createNarratorClient(createAnthropicNarratorTransport({ apiKey })));
  const keyNow = (): string =>
    (options.apiKey === undefined ? (options.env[NARRATOR_API_KEY_ENV] ?? "") : (options.apiKey() ?? "")).trim();
  let enabled = options.enabled;
  // Built lazily on the first current() while "on", and rebuilt when the active key changes.
  let client: NarratorClient | null = null;
  let clientKey = "";
  const listeners = new Set<(client: NarratorClient | null) => void>();

  const availability = (): NarratorAvailability => narratorAvailability(enabled, options.env, keyNow());
  const resolve = (): NarratorClient | null => {
    if (availability() !== "on") return null;
    const key = keyNow();
    if (client === null || clientKey !== key) {
      client = createClient(key);
      clientKey = key;
    }
    return client;
  };

  // What listeners last saw. Compared by availability and key, not by client, so a check never builds a client
  // for a key that is about to be replaced, and an "off" switch never builds one at all.
  let seen = { availability: availability(), key: keyNow() };
  const notifyIfChanged = (): void => {
    const next = { availability: availability(), key: keyNow() };
    const changed = next.availability !== seen.availability || (next.availability === "on" && next.key !== seen.key);
    seen = next;
    if (!changed) return;
    // Without a key the client stays null, but the reason changes (status.narrator "unavailable" vs "off", R3).
    const after = resolve();
    for (const listener of listeners) listener(after);
  };

  return {
    current: resolve,
    availability,
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      notifyIfChanged();
    },
    refresh: notifyIfChanged,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
