import type { JevResult, UIIntent } from "@jevcode/contracts";

export type RenderMode = "autonomous" | "conservative" | "generic" | "suppressed";

export const AUTONOMOUS_THRESHOLD = 0.9;
export const CONSERVATIVE_THRESHOLD = 0.7;
export const GENERIC_THRESHOLD = 0.5;

const DENSITY_ORDER: readonly UIIntent["density"][] = [
  "compact",
  "normal",
  "detailed",
  "expert",
];

function densityStepDown(density: UIIntent["density"]): UIIntent["density"] {
  const index = DENSITY_ORDER.indexOf(density);
  if (index <= 0) return "compact";
  return DENSITY_ORDER[index - 1] ?? "compact";
}

export function renderModeFor(
  confidence: number,
  attention: UIIntent["attention"],
): RenderMode {
  let mode: RenderMode;
  if (confidence >= AUTONOMOUS_THRESHOLD) mode = "autonomous";
  else if (confidence >= CONSERVATIVE_THRESHOLD) mode = "conservative";
  else if (confidence >= GENERIC_THRESHOLD) mode = "generic";
  else mode = "suppressed";
  if (attention === "interrupt" && mode === "suppressed") {
    mode = "conservative";
  }
  return mode;
}

export function renderPolicy(jev: JevResult<UIIntent>): JevResult<UIIntent> {
  const { value } = jev;
  const mode = renderModeFor(jev.confidence, value.attention);
  let density = value.density;
  let showEvidence = value.showEvidence;
  if (mode === "conservative") {
    density = densityStepDown(density);
    showEvidence = true;
  }
  return {
    ...jev,
    value: {
      ...value,
      renderMode: mode,
      density,
      showEvidence,
    },
  };
}
