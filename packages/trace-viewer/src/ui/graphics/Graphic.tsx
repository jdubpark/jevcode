import type { ComponentType, JSX } from "react";

import type { GraphicSpec } from "../../model/index.js";
import { ClaimVsObserved } from "./ClaimVsObserved.js";
import { DiffBar } from "./DiffBar.js";
import { DurationBar } from "./DurationBar.js";
import { FlowGlyph } from "./FlowGlyph.js";
import { ForkGlyph } from "./ForkGlyph.js";
import type { GraphicSize } from "./scales.js";
import { TableGlyph } from "./TableGlyph.js";
import { TestDots } from "./TestDots.js";

type Kind = GraphicSpec["kind"];
export interface GraphicViewProps<K extends Kind> {
  spec: Extract<GraphicSpec, { kind: K }>;
  size: GraphicSize;
  label?: string;
  elapsedMs?: number;
}

export const GRAPHIC_COMPONENTS: { readonly [K in Kind]: ComponentType<GraphicViewProps<K>> } = {
  diff: ({ spec, size, label }) => (
    <DiffBar size={size} label={label} added={spec.added} removed={spec.removed} files={spec.files} moreFiles={spec.moreFiles} />
  ),
  tests: ({ spec, size, label }) => (
    <TestDots size={size} label={label} passed={spec.passed} failed={spec.failed} skipped={spec.skipped} />
  ),
  duration: ({ spec, size, label, elapsedMs }) => (
    <DurationBar size={size} label={label} durationMs={spec.durationMs} running={spec.running} elapsedMs={elapsedMs} end={spec.end} />
  ),
  fork: ({ spec, size, label }) => <ForkGlyph size={size} label={label} options={spec.options} decidedBy={spec.decidedBy} />,
  flow: ({ spec, size, label }) => <FlowGlyph size={size} label={label} nodes={spec.nodes} focus={spec.focus} />,
  table: ({ spec, size, label }) => <TableGlyph size={size} label={label} tables={spec.tables} />,
  claim: ({ spec, size, label }) => <ClaimVsObserved size={size} label={label} claim={spec.claim} observed={spec.observed} />,
};

export function Graphic({ spec, size, label, elapsedMs }: { spec: GraphicSpec; size: GraphicSize; label?: string; elapsedMs?: number }): JSX.Element {
  const Component = GRAPHIC_COMPONENTS[spec.kind] as ComponentType<GraphicViewProps<Kind>>;
  return <Component spec={spec} size={size} label={label} elapsedMs={elapsedMs} />;
}
