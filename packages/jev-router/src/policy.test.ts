import { describe, expect, it } from "vitest";

import type { JevResult, UIIntent } from "@jevcode/contracts";

import { renderModeFor, renderPolicy } from "./policy.js";

function jev(overrides: Partial<JevResult<UIIntent>> = {}): JevResult<UIIntent> {
  return {
    value: {
      attention: "surface",
      subject: "code",
      representation: "summary",
      density: "detailed",
      confidence: 0.8,
      showEvidence: false,
      showCode: false,
      secondaryViews: [],
      renderMode: "generic",
    },
    confidence: 0.8,
    ...overrides,
  };
}

describe("renderModeFor boundaries", () => {
  it("confidence 0.90 is autonomous", () => {
    expect(renderModeFor(0.9, "surface")).toBe("autonomous");
  });

  it("confidence 0.899 is conservative", () => {
    expect(renderModeFor(0.899, "surface")).toBe("conservative");
  });

  it("confidence 0.70 is conservative", () => {
    expect(renderModeFor(0.7, "surface")).toBe("conservative");
  });

  it("confidence 0.699 is generic", () => {
    expect(renderModeFor(0.699, "surface")).toBe("generic");
  });

  it("confidence 0.50 is generic", () => {
    expect(renderModeFor(0.5, "surface")).toBe("generic");
  });

  it("confidence 0.49 is suppressed", () => {
    expect(renderModeFor(0.49, "surface")).toBe("suppressed");
  });

  it("interrupt always renders, even below 0.50", () => {
    expect(renderModeFor(0.1, "interrupt")).toBe("conservative");
  });

  it("interrupt with high confidence stays autonomous", () => {
    expect(renderModeFor(0.95, "interrupt")).toBe("autonomous");
  });
});

describe("renderPolicy", () => {
  it("autonomous keeps density and showEvidence as-is", () => {
    const result = renderPolicy(jev({ confidence: 0.92 }));
    expect(result.value.renderMode).toBe("autonomous");
    expect(result.value.density).toBe("detailed");
    expect(result.value.showEvidence).toBe(false);
  });

  it("conservative steps density down one level and forces showEvidence", () => {
    const result = renderPolicy(jev({ confidence: 0.75 }));
    expect(result.value.renderMode).toBe("conservative");
    expect(result.value.density).toBe("normal");
    expect(result.value.showEvidence).toBe(true);
  });

  it("conservative does not step compact below compact", () => {
    const result = renderPolicy(
      jev({ confidence: 0.75, value: { ...jev().value, density: "compact" } }),
    );
    expect(result.value.density).toBe("compact");
    expect(result.value.showEvidence).toBe(true);
  });

  it("conservative steps expert to detailed", () => {
    const result = renderPolicy(
      jev({ confidence: 0.75, value: { ...jev().value, density: "expert" } }),
    );
    expect(result.value.density).toBe("detailed");
  });

  it("generic renders a summary without forcing evidence", () => {
    const result = renderPolicy(jev({ confidence: 0.55 }));
    expect(result.value.renderMode).toBe("generic");
    expect(result.value.showEvidence).toBe(false);
  });

  it("suppressed keeps everything but the mode", () => {
    const result = renderPolicy(jev({ confidence: 0.3 }));
    expect(result.value.renderMode).toBe("suppressed");
    expect(result.value.density).toBe("detailed");
  });

  it("interrupt below 0.5 renders conservatively with evidence", () => {
    const result = renderPolicy(
      jev({
        confidence: 0.2,
        value: { ...jev().value, attention: "interrupt", density: "detailed" },
      }),
    );
    expect(result.value.renderMode).toBe("conservative");
    expect(result.value.showEvidence).toBe(true);
    expect(result.value.density).toBe("normal");
  });
});
