import {
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "@jevcode/contracts";

export interface EventNormalizerContext {
  sessionId: string;
  now: () => string;
  // Minted by the adapter once per agent process (exec or exec resume) and
  // stamped on every event that process produces. Absent in legacy callers.
  turnId?: string;
}

export const defaultNormalizerContext = (
  sessionId: string,
): EventNormalizerContext => ({
  sessionId,
  now: () => new Date().toISOString(),
});

export type AgentEventMapper = (
  raw: unknown,
  ctx: EventNormalizerContext,
) => NormalizedAgentEvent[];

export function applyMappers(
  raw: unknown,
  ctx: EventNormalizerContext,
  mappers: readonly AgentEventMapper[],
): NormalizedAgentEvent[] {
  const events: NormalizedAgentEvent[] = [];
  for (const mapper of mappers) {
    events.push(...mapper(raw, ctx));
  }
  return events;
}

export function validateNormalizedAgentEvent(
  event: NormalizedAgentEvent,
): NormalizedAgentEvent {
  return NormalizedAgentEventSchema.parse(event);
}
