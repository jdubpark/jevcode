import type { ComponentType } from "react";

import type { SignalId } from "../../../../../model/index.js";
import type { FindingBodyProps } from "../Spine.js";
import { ClaimFinding } from "./ClaimFinding.js";
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

export function FindingBody(props: FindingBodyProps) {
  const Body = FINDING_BODY[props.finding.ruleId];
  return <Body {...props} />;
}
