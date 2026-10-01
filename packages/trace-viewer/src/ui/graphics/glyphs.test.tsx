// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeGraphic, type GraphicSpec } from "../../model/index.js";
import { ClaimVsObserved } from "./ClaimVsObserved.js";
import { FlowGlyph } from "./FlowGlyph.js";
import { ForkGlyph } from "./ForkGlyph.js";
import { Graphic, GRAPHIC_COMPONENTS } from "./Graphic.js";
import { TableGlyph } from "./TableGlyph.js";

afterEach(() => cleanup());

const KINDS = ["diff", "tests", "duration", "fork", "flow", "table", "claim"] as const satisfies readonly GraphicSpec["kind"][];
type Missing = Exclude<GraphicSpec["kind"], (typeof KINDS)[number]>;
const exhaustive: [Missing] extends [never] ? true : false = true;

describe("ForkGlyph", () => {
  it("draws 3 branches and +1 for 4 options, the chosen branch solid and others dashed", () => {
    const options = [
      { label: "explicit_link", chosen: true },
      { label: "auto_link_by_email", chosen: false },
      { label: "reject", chosen: false },
      { label: "ask_later", chosen: false },
    ];
    const { container } = render(<ForkGlyph size="sm" options={options} decidedBy="supervisor" />);
    const branches = [...container.querySelectorAll("path[data-branch]")];
    expect(branches).toHaveLength(3);
    const chosen = branches.filter((b) => b.getAttribute("data-chosen") === "true");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.getAttribute("stroke-dasharray")).toBeNull();
    for (const b of branches.filter((x) => x.getAttribute("data-chosen") === "false")) {
      expect(b.getAttribute("stroke-dasharray")).toBe("2 2");
    }
    expect(container.textContent).toContain("+1");
  });

  it("keeps the chosen option when it is the fourth", () => {
    const options = ["a", "b", "c", "d"].map((label) => ({ label, chosen: label === "d" }));
    const { container } = render(<ForkGlyph size="xs" options={options} decidedBy="delegated" />);
    const branches = [...container.querySelectorAll("path[data-branch]")];
    expect(branches.map((b) => b.getAttribute("data-branch"))).toEqual(["a", "b", "d"]);
  });

  it("an open decision has no solid branch", () => {
    const options = [{ label: "a", chosen: false }, { label: "b", chosen: false }];
    const { container } = render(<ForkGlyph size="xs" options={options} decidedBy="open" />);
    expect(container.querySelectorAll('path[data-chosen="true"]')).toHaveLength(0);
  });
});

describe("ClaimVsObserved", () => {
  const text = "OAuth implementation complete; all checks pass.";
  const start = text.indexOf("all checks pass");
  const span = [start, start + "all checks pass".length] as const;

  it("underlines exactly the claim span and renders the claim as text", () => {
    const { container } = render(
      <ClaimVsObserved size="md" claim={{ text, span, tMs: 43_000 }} observed={{ passed: 14, failed: 1, command: "pnpm test", tMs: 35_000 }} />,
    );
    expect(container.querySelector("[data-claim-span]")?.textContent).toBe("all checks pass");
    expect(container.textContent).toContain(text);
    expect(container.textContent).toContain("1 failed");
    expect(container.textContent).toContain("pnpm test");
  });

  it("renders markup in agent text as text", () => {
    const hostile = "<img src=x onerror=alert(1)> all tests pass";
    const { container } = render(
      <ClaimVsObserved size="sm" claim={{ text: hostile, tMs: 1 }} observed={{ passed: 0, failed: 1, command: "pnpm test", tMs: 0 }} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("the observed card is a button when clickable", () => {
    const onObservedClick = vi.fn();
    render(
      <ClaimVsObserved size="md" claim={{ text, span, tMs: 43_000 }} observed={{ passed: 14, failed: 1, command: "pnpm test", tMs: 35_000 }} onObservedClick={onObservedClick} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /1 failed/ }));
    expect(onObservedClick).toHaveBeenCalledTimes(1);
  });

  it("the observed button leaves the tab order when a roving region asks (spec §7.13)", () => {
    const onObservedClick = vi.fn();
    const claim = { text, span, tMs: 43_000 };
    const observed = { passed: 14, failed: 1, command: "pnpm test", tMs: 35_000 };
    const standalone = render(<ClaimVsObserved size="md" claim={claim} observed={observed} onObservedClick={onObservedClick} />);
    expect(standalone.getByRole("button").tabIndex).toBe(0);
    standalone.unmount();
    render(<ClaimVsObserved size="md" claim={claim} observed={observed} onObservedClick={onObservedClick} observedTabIndex={-1} />);
    const button = screen.getByRole("button", { name: /1 failed/ });
    expect(button.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(button);
    expect(onObservedClick).toHaveBeenCalledTimes(1);
  });
});

describe("mono slots (spec §6.8, §9)", () => {
  it("show bidi and control characters in paths, commands, stems and table names as visible tokens", () => {
    const specs: GraphicSpec[] = [
      { kind: "diff", added: 3, removed: 1, files: [{ path: "src/\u202Est.exe", added: 3, removed: 1 }] },
      {
        kind: "claim",
        claim: { text: "all tests pass", tMs: 43_000 },
        observed: { passed: 14, failed: 1, command: "rm \u202Efdp.exe", tMs: 35_000 },
      },
      { kind: "flow", nodes: ["identity", "goo\u2066gle"], focus: 0 },
      { kind: "table", tables: [{ name: "users\u0007", role: "altered", columns: 1 }] },
    ];
    const text = specs.map((spec) => render(<Graphic spec={spec} size="sm" />).container.textContent ?? "").join("\n");
    expect(text).toContain("src/⟨U+202E⟩st.exe");
    expect(text).toContain("rm ⟨U+202E⟩fdp.exe");
    expect(text).toContain("goo⟨U+2066⟩gle");
    expect(text).toContain("users⟨U+0007⟩");
    for (const raw of ["\u202E", "\u2066", "\u0007"]) expect(text).not.toContain(raw);
  });

  it("leave a command the caller already made display-safe unchanged", () => {
    const { container } = render(
      <ClaimVsObserved size="sm" claim={{ text: "done", tMs: 1 }} observed={{ passed: 0, failed: 1, command: "rm ⟨U+202E⟩fdp.exe", tMs: 0 }} />,
    );
    expect(container.textContent).toContain("rm ⟨U+202E⟩fdp.exe");
  });
});

describe("FlowGlyph and TableGlyph", () => {
  it("FlowGlyph shows 3 nodes then an ellipsis and marks the focus", () => {
    const { container } = render(<FlowGlyph size="md" nodes={["identity", "google", "service", "index"]} focus={1} />);
    const nodes = [...container.querySelectorAll("[data-node]")];
    expect(nodes.map((n) => n.textContent)).toEqual(["identity", "google", "service"]);
    expect(nodes[1]?.getAttribute("data-focus")).toBe("true");
    expect(container.textContent).toContain("…");
  });

  it("TableGlyph shows at most two tables with column counts", () => {
    const tables = [
      { name: "identities", role: "new" as const, columns: 5 },
      { name: "users", role: "altered" as const, columns: 1 },
      { name: "sessions", role: "altered" as const, columns: 2 },
    ];
    const { container } = render(<TableGlyph size="sm" tables={tables} />);
    expect(container.querySelectorAll("[data-table]")).toHaveLength(2);
    expect(container.textContent).toContain("identities");
    expect(container.textContent).toContain("5 cols");
  });
});

describe("Graphic map", () => {
  it("has an entry for every GraphicSpec kind", () => {
    expect(exhaustive).toBe(true);
    expect(Object.keys(GRAPHIC_COMPONENTS).sort()).toEqual([...KINDS].sort());
  });

  it("renders a spec through its component", () => {
    const { container } = render(<Graphic spec={{ kind: "tests", passed: 14, failed: 1, skipped: 0 }} size="xs" label="14 passed, 1 failed" />);
    expect(container.querySelectorAll("circle[data-state]")).toHaveLength(15);
    const running = render(<Graphic spec={{ kind: "duration", durationMs: null, running: true, status: "running", end: "none" }} size="xs" elapsedMs={10_000} />);
    expect(running.container.querySelector('rect[data-bar="hollow"]')).not.toBeNull();
  });
});

describe("untrusted text in accessible names (spec §16)", () => {
  const BIDI = ["‮", "⁦", "\u0007"];
  it("describeGraphic shows bidi and control characters as tokens in every agent-text slot", () => {
    const specs: GraphicSpec[] = [
      { kind: "fork", decidedBy: "supervisor", options: [{ label: "pick‮ one", chosen: true }, { label: "b", chosen: false }] },
      { kind: "flow", nodes: ["identity", "goo⁦gle"], focus: 0 },
      { kind: "table", tables: [{ name: "users\u0007", role: "altered", columns: 1 }] },
      {
        kind: "claim",
        claim: { text: "all‮ pass", tMs: 1 },
        observed: { passed: 1, failed: 0, command: "rm ‮fdp.exe", tMs: 0 },
      },
    ];
    const text = specs.map((spec) => describeGraphic(spec)).join("\n");
    for (const raw of BIDI) expect(text).not.toContain(raw);
    expect(text).toContain("pick⟨U+202E⟩ one");
    expect(text).toContain("goo⟨U+2066⟩gle");
    expect(text).toContain("users⟨U+0007⟩");
    expect(text).toContain("all⟨U+202E⟩ pass");
    expect(text).toContain("rm ⟨U+202E⟩fdp.exe");
  });

  it("ForkGlyph keeps no raw bidi character in a branch attribute", () => {
    const { container } = render(
      <ForkGlyph size="sm" label="x" options={[{ label: "a‮b", chosen: true }, { label: "c", chosen: false }]} decidedBy="supervisor" />,
    );
    expect(container.querySelector("[data-branch]")?.getAttribute("data-branch")).toBe("a⟨U+202E⟩b");
  });
});
