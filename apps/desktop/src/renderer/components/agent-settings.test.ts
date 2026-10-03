// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NarratorAvailability } from "../../shared/narrator-log.js";
import { DEFAULT_AGENT_PREFERENCES } from "../../shared/prefs.js";
import { AgentSettings } from "./AgentSettings.js";

const NOTE_ON = "Sends file paths, symbol names and the first README paragraph to Claude Haiku. File contents are never sent.";
const NOTE_OFF = "Rule-based labels only. Nothing leaves this machine.";
const NOTE_NO_KEY = "ANTHROPIC_API_KEY is not set, so labels stay rule-based. Nothing leaves this machine.";

let host: HTMLDivElement;
let root: Root;
/** Every bridge property AgentSettings reads; the note must come from props alone. */
let bridgeReads: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  bridgeReads = [];
  const bridge = new Proxy(
    {},
    {
      get: (_target, key) => {
        bridgeReads.push(String(key));
        return new Proxy(() => Promise.resolve({ availability: "on", calls: [] }), {
          get: (_inner, method) => {
            bridgeReads.push(`${String(key)}.${String(method)}`);
            return () => Promise.resolve({ availability: "on", calls: [] });
          },
        });
      },
    },
  );
  (window as unknown as { jevcode: unknown }).jevcode = bridge;
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  delete (window as unknown as { jevcode?: unknown }).jevcode;
});

async function render(explainWithModel: boolean, narratorAvailability?: NarratorAvailability): Promise<string> {
  await act(async () => {
    root.render(
      createElement(AgentSettings, {
        prefs: { ...DEFAULT_AGENT_PREFERENCES, explainWithModel },
        ...(narratorAvailability === undefined ? {} : { narratorAvailability }),
        onSet: () => undefined,
      }),
    );
  });
  return host.querySelector("#narrator-setting-note")?.textContent ?? "";
}

describe("AgentSettings: what leaves the machine (spec §10, E15)", () => {
  it.each([
    [true, "on", NOTE_ON],
    [false, "off_setting", NOTE_OFF],
    [true, "off_no_key", NOTE_NO_KEY],
  ] as const)("explainWithModel %s with availability %s shows the matching note and reads nothing from the bridge", async (enabled, availability, note) => {
    expect(await render(enabled, availability)).toBe(note);
    expect(bridgeReads).toEqual([]);
  });

  it("falls back to the setting when main sent no availability", async () => {
    expect(await render(true)).toBe(NOTE_ON);
    expect(await render(false)).toBe(NOTE_OFF);
    expect(bridgeReads).toEqual([]);
  });

  it("switches the note with the preferences broadcast, never showing an empty note", async () => {
    expect(await render(true, "on")).toBe(NOTE_ON);
    expect(await render(false, "off_setting")).toBe(NOTE_OFF);
    expect(await render(true, "on")).toBe(NOTE_ON);
    expect(bridgeReads).toEqual([]);
  });
});
