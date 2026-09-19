import {
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "@jevcode/contracts";

export interface EventNormalizerContext {
  sessionId: string;
  now: () => string;
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
