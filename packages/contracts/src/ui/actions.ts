import { z } from "zod";

export const CATALOG_ACTION_NAMES = [
  "answer_decision",
  "delegate_decision",
  "restore_previous_api_semantics",
  "inspect_call_sites",
  "show_exact_diff",
  "accept_changes",
  "request_changes",
  "continue_task",
  "open_terminal",
  "interrupt_agent",
  "pin_surface",
  "dismiss_surface",
] as const;

export type CatalogActionName = (typeof CATALOG_ACTION_NAMES)[number];

export const AnswerDecisionParamsSchema = z.object({
  decisionId: z.string().min(1),
  decision: z.record(z.string(), z.string()),
  evidence: z.array(z.string().min(1)).optional(),
});

export type AnswerDecisionParams = z.infer<typeof AnswerDecisionParamsSchema>;

export const DelegateDecisionParamsSchema = z.object({
  decisionId: z.string().min(1),
});

export type DelegateDecisionParams = z.infer<typeof DelegateDecisionParamsSchema>;

export const RestorePreviousApiSemanticsParamsSchema = z.object({
  symbol: z.string().min(1),
});

export type RestorePreviousApiSemanticsParams = z.infer<
  typeof RestorePreviousApiSemanticsParamsSchema
>;

export const InspectCallSitesParamsSchema = z.object({
  symbol: z.string().min(1),
});

export type InspectCallSitesParams = z.infer<typeof InspectCallSitesParamsSchema>;

export const ShowExactDiffParamsSchema = z.object({
  files: z.array(z.string().min(1)).min(1),
});

export type ShowExactDiffParams = z.infer<typeof ShowExactDiffParamsSchema>;

export const AcceptChangesParamsSchema = z.object({
  changeUnitId: z.string().optional(),
  updateTest: z.string().optional(),
});

export type AcceptChangesParams = z.infer<typeof AcceptChangesParamsSchema>;

export const RequestChangesParamsSchema = z.object({
  changeUnitId: z.string().optional(),
  instruction: z.string().optional(),
});

export type RequestChangesParams = z.infer<typeof RequestChangesParamsSchema>;

export const NoopActionParamsSchema = z.object({});

export type NoopActionParams = z.infer<typeof NoopActionParamsSchema>;

export const SurfaceTargetParamsSchema = z.object({
  surfaceId: z.string().min(1),
});

export type SurfaceTargetParams = z.infer<typeof SurfaceTargetParamsSchema>;

export const actionParamSchemas = {
  answer_decision: AnswerDecisionParamsSchema,
  delegate_decision: DelegateDecisionParamsSchema,
  restore_previous_api_semantics: RestorePreviousApiSemanticsParamsSchema,
  inspect_call_sites: InspectCallSitesParamsSchema,
  show_exact_diff: ShowExactDiffParamsSchema,
  accept_changes: AcceptChangesParamsSchema,
  request_changes: RequestChangesParamsSchema,
  continue_task: NoopActionParamsSchema,
  open_terminal: NoopActionParamsSchema,
  interrupt_agent: NoopActionParamsSchema,
  pin_surface: SurfaceTargetParamsSchema,
  dismiss_surface: SurfaceTargetParamsSchema,
} as const satisfies Record<CatalogActionName, z.ZodType>;

export type CatalogActionParams = {
  [K in CatalogActionName]: z.infer<(typeof actionParamSchemas)[K]>;
};

export const ActionRefSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("answer_decision"),
    params: AnswerDecisionParamsSchema,
  }),
  z.object({
    action: z.literal("delegate_decision"),
    params: DelegateDecisionParamsSchema,
  }),
  z.object({
    action: z.literal("restore_previous_api_semantics"),
    params: RestorePreviousApiSemanticsParamsSchema,
  }),
  z.object({
    action: z.literal("inspect_call_sites"),
    params: InspectCallSitesParamsSchema,
  }),
  z.object({
    action: z.literal("show_exact_diff"),
    params: ShowExactDiffParamsSchema,
  }),
  z.object({
    action: z.literal("accept_changes"),
    params: AcceptChangesParamsSchema,
  }),
  z.object({
    action: z.literal("request_changes"),
    params: RequestChangesParamsSchema,
  }),
  z.object({
    action: z.literal("continue_task"),
    params: NoopActionParamsSchema,
  }),
  z.object({
    action: z.literal("open_terminal"),
    params: NoopActionParamsSchema,
  }),
  z.object({
    action: z.literal("interrupt_agent"),
    params: NoopActionParamsSchema,
  }),
  z.object({
    action: z.literal("pin_surface"),
    params: SurfaceTargetParamsSchema,
  }),
  z.object({
    action: z.literal("dismiss_surface"),
    params: SurfaceTargetParamsSchema,
  }),
]);

export type ActionRef = z.infer<typeof ActionRefSchema>;
