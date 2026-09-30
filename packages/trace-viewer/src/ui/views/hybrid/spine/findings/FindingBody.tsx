import type { ComponentType } from "react";

import type { SignalId } from "../../../../../model/index.js";
import type { FindingBodyProps } from "../Spine.js";
import { ClaimChain, ClaimFinding } from "./ClaimFinding.js";
import { DestructiveFinding } from "./DestructiveFinding.js";
import { GuardrailFinding } from "./GuardrailFinding.js";
import { RecoveryFinding } from "./RecoveryFinding.js";
import { TestsFinding } from "./TestsFinding.js";

/** A new signal fails typecheck until it has a body (spec §7.6.3). */
export const FINDING_BODY = {
  claim_contradicted: ClaimFinding,
  failing_tests: TestsFinding,
  destructive_command: DestructiveFinding,
  guardrail_clamp: GuardrailFinding,
  recovery_arc: RecoveryFinding,
} as const satisfies { readonly [K in SignalId]: ComponentType<FindingBodyProps> };

/** Optional extras shown on the expanded row's header line, after the title (mockup: the claim chain). */
export const FINDING_HEADER: { readonly [K in SignalId]?: ComponentType<FindingBodyProps> } = {
  claim_contradicted: ClaimChain,
};

export function FindingBody(props: FindingBodyProps) {
  if (props.part === "header") {
    const Header = FINDING_HEADER[props.finding.ruleId];
    return Header === undefined ? null : <Header {...props} />;
  }
  const Body = FINDING_BODY[props.finding.ruleId];
  return <Body {...props} />;
}
