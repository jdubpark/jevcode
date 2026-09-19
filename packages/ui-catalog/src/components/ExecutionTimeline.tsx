import type {
  ExecutionTimelineProps,
  TimelineEvent,
  TimelineEventKind,
} from "@jevcode/contracts";

export const MILESTONE_KIND_LABELS: Record<
  Exclude<TimelineEventKind, "agent">,
  string
> = {
  change: "change",
  validation: "test",
  decision: "decision",
  command: "command",
  failure: "failure",
};

export function isMilestoneEvent(event: TimelineEvent): boolean {
  return event.kind !== "agent";
}

export function ExecutionTimeline({ props }: { props: ExecutionTimelineProps }) {
  const milestones = props.events.filter(isMilestoneEvent);
  return (
    <div
      className="jevcode-execution-timeline"
      data-testid="execution-timeline"
      data-event-count={props.events.length}
      data-milestone-count={milestones.length}
    >
      {props.title !== undefined ? (
        <h3 className="jevcode-title">{props.title}</h3>
      ) : null}
      <ol className="jevcode-timeline">
        {milestones.map((event) => (
          <li key={event.id} data-timeline-event={event.id}>
            <span
              className="jevcode-timeline-ts"
              data-ts={event.ts}
            >
              {event.ts}
            </span>
            {event.kind !== undefined && event.kind !== "agent" ? (
              <span
                className="jevcode-timeline-kind"
                data-kind={event.kind}
              >
                {MILESTONE_KIND_LABELS[event.kind]}
              </span>
            ) : null}
            <span className="jevcode-timeline-label">{event.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
