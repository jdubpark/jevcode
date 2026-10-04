// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_PREFERENCES } from "../../shared/prefs.js";
import type { PreferencesView } from "../../shared/prefs.js";
import { FeaturesSection } from "./FeaturesSection.js";

afterEach(cleanup);

const prefs = (extra: Partial<PreferencesView> = {}): PreferencesView => ({ ...DEFAULT_AGENT_PREFERENCES, ...extra });

describe("FeaturesSection", () => {
  it("turns the narrator off and on, with its disclosure note", () => {
    const onSet = vi.fn();
    render(<FeaturesSection prefs={prefs({ narratorAvailability: "on" })} onSet={onSet} />);
    const toggle = screen.getByRole("checkbox", { name: "Explain with a model" });
    expect(screen.getByText(/Sends to Claude Haiku/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(onSet).toHaveBeenCalledWith({ explainWithModel: false });
  });

  it("describes the narrator by main's availability, falling back to the setting (spec §10, E15)", () => {
    const note = (): string => {
      const id = screen.getByRole("checkbox", { name: "Explain with a model" }).getAttribute("aria-describedby") ?? "";
      return document.getElementById(id)?.textContent ?? "";
    };
    const { rerender } = render(<FeaturesSection prefs={prefs({ narratorAvailability: "off_no_key" })} onSet={vi.fn()} />);
    expect(note()).toMatch(/^No Anthropic key is set/);
    rerender(<FeaturesSection prefs={prefs({ explainWithModel: false })} onSet={vi.fn()} />);
    expect(note()).toBe("Rule-based labels only. Nothing leaves this machine.");
    rerender(<FeaturesSection prefs={prefs({ explainWithModel: true })} onSet={vi.fn()} />);
    expect(note()).toMatch(/^Sends to Claude Haiku/);
  });

  it("sets the agent backend and Jev client, marked as applying to new sessions", () => {
    const onSet = vi.fn();
    render(<FeaturesSection prefs={prefs()} onSet={onSet} />);
    fireEvent.change(screen.getByLabelText("Agent backend"), { target: { value: "mock" } });
    fireEvent.change(screen.getByLabelText("Jev decisions"), { target: { value: "offline" } });
    expect(onSet).toHaveBeenCalledWith({ agentBackend: "mock" });
    expect(onSet).toHaveBeenCalledWith({ jevClient: "offline" });
    expect(screen.getAllByText("Applies to new sessions")).toHaveLength(2);
  });

  it("disables a control that the environment overrides, and says so", () => {
    render(<FeaturesSection prefs={prefs({ agentBackendOverride: "mock", jevClientOverride: "degrade", narratorAvailability: "off_env" })} onSet={vi.fn()} />);
    expect((screen.getByLabelText("Agent backend") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("Set by JEVC_AGENT=mock (environment)")).toBeTruthy();
    expect((screen.getByLabelText("Jev decisions") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("Set by JEVC_JEV_CLIENT=degrade (environment)")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Explain with a model" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("keeps the Codex model, reasoning effort and usage budget", () => {
    const onSet = vi.fn();
    render(<FeaturesSection prefs={prefs()} onSet={onSet} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });
    fireEvent.change(screen.getByLabelText("Reasoning"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Usage budget unknown" }));
    expect(onSet).toHaveBeenCalledWith({ model: "gpt-5.6-sol" });
    expect(onSet).toHaveBeenCalledWith({ reasoningEffort: "high" });
    expect(onSet).toHaveBeenCalledWith({ usageBudgetFraction: "0.40" });
  });

  it("marks the Codex model, reasoning effort and usage budget once as applying to new sessions, and not the narrator", () => {
    render(<FeaturesSection prefs={prefs({ narratorAvailability: "on" })} onSet={vi.fn()} />);
    const codex = screen.getByRole("group", { name: "Codex · applies to new sessions" });
    expect(within(codex).getByLabelText("Model")).toBeTruthy();
    expect(within(codex).getByLabelText("Reasoning")).toBeTruthy();
    expect(within(codex).getByRole("slider", { name: "Usage budget" })).toBeTruthy();
    expect(within(codex).queryByText("Applies to new sessions")).toBeNull();
    expect(within(codex).queryByRole("checkbox", { name: "Explain with a model" })).toBeNull();
    // Agent backend, Jev decisions and the Codex group; the narrator applies at once.
    expect(screen.getAllByText(/applies to new sessions/i)).toHaveLength(3);
  });
});
