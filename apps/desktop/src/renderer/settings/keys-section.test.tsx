// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretsView } from "../../shared/secrets.js";
import { KeysSection } from "./KeysSection.js";

const SECRET = "sk-ant-api03-secret-value-9f3a";
const none = (canSave = true): SecretsView => ({
  canSave,
  fileUnreadable: false,
  keys: [
    { name: "ANTHROPIC_API_KEY", set: false, source: "none", last4: null, envAlsoSet: false, unreadable: false },
    { name: "TYPESAFE_API_KEY", set: false, source: "none", last4: null, envAlsoSet: false, unreadable: false },
  ],
});
const saved: SecretsView = { ...none(), keys: [{ ...none().keys[0]!, set: true, source: "app", last4: "9f3a" }, none().keys[1]!] };

afterEach(cleanup);

function api(overrides: Partial<Parameters<typeof KeysSection>[0]["api"]> = {}) {
  return {
    set: vi.fn(async () => saved),
    remove: vi.fn(async () => none()),
    test: vi.fn(async () => ({ result: "ok" as const })),
    ...overrides,
  };
}

describe("KeysSection", () => {
  it("adds a key without ever rendering it, and saves it trimmed (Review Focus 1)", async () => {
    const keys = api();
    render(<KeysSection view={none()} api={keys} />);
    const row = screen.getByRole("group", { name: /Anthropic/ });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    const field = within(row).getByLabelText("Anthropic key") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    // A password field drops line breaks itself (HTML value sanitization); the spaces reach main, which trims them.
    fireEvent.change(field, { target: { value: `  ${SECRET}\n` } });
    // Not even while typing: a controlled field would mirror the key into its value attribute.
    expect(document.body.innerHTML).not.toContain(SECRET);
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(keys.set).toHaveBeenCalledWith("ANTHROPIC_API_KEY", `  ${SECRET}`));
    await waitFor(() => expect(screen.queryByLabelText("Anthropic key")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("shows a refusal without repeating the value", async () => {
    const keys = api({ set: vi.fn(async () => Promise.reject(new Error("A key must be 1 to 512 characters with no spaces or control characters."))) });
    render(<KeysSection view={none()} api={keys} />);
    const row = screen.getByRole("group", { name: /Anthropic/ });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    fireEvent.change(within(row).getByLabelText("Anthropic key"), { target: { value: "has space" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await screen.findByText(/no spaces or control characters/);
    expect(document.body.textContent).not.toContain("has space");
  });

  it("offers Replace, Remove and Test for a saved key, and reports the check", async () => {
    const keys = api();
    render(<KeysSection view={saved} api={keys} />);
    const row = screen.getByRole("group", { name: /Anthropic/ });
    expect(within(row).getByText("Saved in app · …9f3a")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Test" }));
    await within(row).findByText("Key works");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(keys.remove).toHaveBeenCalledWith("ANTHROPIC_API_KEY"));
    expect(within(screen.getByRole("group", { name: /TypeSafe/ })).queryByRole("button", { name: "Test" })).toBeNull();
  });

  it("disables saving where the OS cannot encrypt, and says why", () => {
    render(<KeysSection view={none(false)} api={api()} />);
    expect((screen.getAllByRole("button", { name: "Add" })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("This system cannot encrypt saved keys; set the key in the environment instead.")).toBeTruthy();
  });

  it("offers Replace but no Remove for an environment key", () => {
    const fromEnv: SecretsView = { ...none(), keys: [{ ...none().keys[0]!, set: true, source: "env", last4: "c3d4" }, none().keys[1]!] };
    render(<KeysSection view={fromEnv} api={api()} />);
    const anthropic = screen.getByRole("group", { name: /Anthropic/ });
    expect(within(anthropic).getByText("From environment · …c3d4")).toBeTruthy();
    expect(within(anthropic).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(anthropic).getByRole("button", { name: "Replace" })).toBeTruthy();
  });

  it("disables Test while no Anthropic key is active", () => {
    render(<KeysSection view={none()} api={api()} />);
    const anthropic = screen.getByRole("group", { name: /Anthropic/ });
    expect((within(anthropic).getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
