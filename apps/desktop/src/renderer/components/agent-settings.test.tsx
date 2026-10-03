// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NarratorAvailability } from "../../shared/narrator-log.js";
import { DEFAULT_AGENT_PREFERENCES } from "../../shared/prefs.js";
import { AgentSettings } from "./AgentSettings.js";

const NOTE_ON = "Sends to Claude Haiku: file paths, component and symbol names, dependency names, import edges and counts, package descriptions and the first README paragraph (redacted). File contents are never sent.";
const NOTE_OFF = "Rule-based labels only. Nothing leaves this machine.";
const NOTE_NO_KEY = "ANTHROPIC_API_KEY is not set, so labels stay rule-based. Nothing leaves this machine.";

/** Every bridge property AgentSettings reads; the note must come from props alone. */
let bridgeReads: string[];

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { jevcode?: unknown }).jevcode;
});

function settings(explainWithModel: boolean, narratorAvailability?: NarratorAvailability) {
  return (
    <AgentSettings
      prefs={{ ...DEFAULT_AGENT_PREFERENCES, explainWithModel }}
      {...(narratorAvailability === undefined ? {} : { narratorAvailability })}
      onSet={() => undefined}
    />
  );
}

/** Renders the settings row and opens it; the note lives in the collapsible body. */
function renderOpen(explainWithModel: boolean, narratorAvailability?: NarratorAvailability) {
  const view = render(settings(explainWithModel, narratorAvailability));
  fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
  return view;
}

/** The note the checkbox is described by. */
function note(): string {
  const id = screen.getByRole("checkbox", { name: "Explain with a model" }).getAttribute("aria-describedby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

describe("AgentSettings: what leaves the machine (spec §10, E15)", () => {
  it("keeps the setting and its note inside the collapsed Agent settings row", () => {
    render(settings(true, "on"));
    expect(screen.queryByRole("checkbox", { name: "Explain with a model" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(screen.getByRole("checkbox", { name: "Explain with a model" })).toBeTruthy();
  });

  it.each([
    [true, "on", NOTE_ON],
    [false, "off_setting", NOTE_OFF],
    [true, "off_no_key", NOTE_NO_KEY],
  ] as const)("explainWithModel %s with availability %s shows the matching note and reads nothing from the bridge", (enabled, availability, expected) => {
    renderOpen(enabled, availability);
    expect(note()).toBe(expected);
    expect(bridgeReads).toEqual([]);
  });

  it("falls back to the setting when main sent no availability", () => {
    const { rerender } = renderOpen(true);
    expect(note()).toBe(NOTE_ON);
    rerender(settings(false));
    expect(note()).toBe(NOTE_OFF);
    expect(bridgeReads).toEqual([]);
  });

  it("switches the note with the preferences broadcast, never showing an empty note", () => {
    const { rerender } = renderOpen(true, "on");
    expect(note()).toBe(NOTE_ON);
    rerender(settings(false, "off_setting"));
    expect(note()).toBe(NOTE_OFF);
    rerender(settings(true, "on"));
    expect(note()).toBe(NOTE_ON);
    expect(bridgeReads).toEqual([]);
  });

  it("the checkbox sends the explainWithModel patch", () => {
    const patches: unknown[] = [];
    render(
      <AgentSettings
        prefs={{ ...DEFAULT_AGENT_PREFERENCES, explainWithModel: true }}
        narratorAvailability="on"
        onSet={(patch) => patches.push(patch)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Explain with a model" }));
    expect(patches).toEqual([{ explainWithModel: false }]);
  });
});
