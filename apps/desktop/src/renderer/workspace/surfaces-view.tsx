import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { NormalizedAgentEvent } from "@jevcode/contracts";
import type { ViewDefinition, ViewProps } from "@jevcode/trace-viewer";
import { agentEventLabel, formatClock } from "@jevcode/trace-viewer/model";
import { registry } from "@jevcode/ui-catalog";
import { useEffect, useMemo, useState } from "react";

import type { SessionStatePayload } from "../payload-types.js";
import { eventKey, isConversationEvent, useSurfacesContext, type SurfaceEntry } from "./session-surfaces.js";

type SurfacesFilter = "overview" | "conversation" | "decisions";
const MAX_VISIBLE_EVENTS = 80;


function ActivityMark({ kind }: { kind: string }) {
  return (
    <svg className="activity-mark" viewBox="0 0 20 20" aria-hidden="true">
      {kind === "message" ? (
        <path d="M4 4.75h12v8.5H9l-3.75 2.5v-2.5H4z" />
      ) : kind === "success" ? (
        <path d="m5 10 3 3 7-7" />
      ) : kind === "file" ? (
        <path d="M5 2.75h6l4 4v10.5H5zM11 2.75v4h4" />
      ) : kind === "command" ? (
        <path d="m5 6 4 4-4 4m6 0h4" />
      ) : kind === "warning" ? (
        <path d="M10 3 17 16H3zm0 4v4m0 2.5v.5" />
      ) : (
        <path d="M10 3v3m0 8v3M3 10h3m8 0h3M5.05 5.05l2.12 2.12m5.66 5.66 2.12 2.12m0-9.9-2.12 2.12m-5.66 5.66-2.12 2.12" />
      )}
    </svg>
  );
}

function MessageText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > 760;
  const visible = collapsible && !expanded ? `${text.slice(0, 720).trimEnd()}…` : text;
  return (
    <>
      <p>{visible}</p>
      {collapsible ? (
        <button
          type="button"
          className="activity-message-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Read full update"}
        </button>
      ) : null}
    </>
  );
}

function ActivityEvent({ event }: { event: NormalizedAgentEvent }) {
  if (event.type === "agent_started") {
    return (
      <article className="activity-message activity-message-user">
        <div className="activity-avatar">You</div>
        <div>
          <div className="activity-message-meta">
            <strong>Task direction</strong>
            <time>{formatClock(event.ts)}</time>
          </div>
          <MessageText text={event.prompt} />
        </div>
      </article>
    );
  }

  if (event.type === "agent_message") {
    return (
      <article className={`activity-message activity-message-${event.role}`}>
        <div className="activity-avatar">{event.role === "user" ? "You" : "J"}</div>
        <div>
          <div className="activity-message-meta">
            <strong>{event.role === "user" ? "Your direction" : "Agent note"}</strong>
            <time>{formatClock(event.ts)}</time>
          </div>
          <MessageText text={event.text} />
        </div>
      </article>
    );
  }

  let kind = "work";
  if (event.type === "file_changed") kind = "file";
  if (event.type === "command_started" || event.type === "command_completed") kind = "command";
  if (event.type === "test_completed" && event.exitCode === 0) kind = "success";
  if (event.type === "agent_completed") kind = "success";
  if (event.type === "agent_failed" || event.type === "approval_requested") kind = "warning";

  const detail =
    event.type === "tool_started"
      ? event.input
      : event.type === "command_completed"
        ? [event.stdout, event.stderr].filter(Boolean).join("\n")
        : "";

  return (
    <article className="activity-operation" data-event-type={event.type}>
      <span className={`activity-operation-icon activity-operation-${kind}`}>
        <ActivityMark kind={kind} />
      </span>
      <div className="activity-operation-copy">
        <div>
          <span>{agentEventLabel(event)}</span>
          <time>{formatClock(event.ts)}</time>
        </div>
        {detail.length > 0 ? (
          <details>
            <summary>Show details</summary>
            <pre>{detail.slice(0, 5000)}</pre>
          </details>
        ) : null}
      </div>
    </article>
  );
}


function SessionOverview({
  sessionState,
  events,
  entries,
  openDecisions,
}: {
  sessionState: SessionStatePayload;
  events: readonly NormalizedAgentEvent[];
  entries: readonly SurfaceEntry[];
  openDecisions: number;
}) {
  const notes = events.filter(
    (event) => event.type === "agent_message" && event.role === "assistant",
  ).length;
  const verificationViews = entries.filter(
    (entry) => entry.meta.group === "verification",
  ).length;
  const terminal = sessionState.state === "completed" || sessionState.state === "failed";
  return (
    <div className="session-overview" aria-label="Session overview">
      <div className="overview-step" data-state={notes > 0 ? "complete" : "pending"}>
        <span className="overview-node" />
        <div>
          <strong>Context</strong>
          <span>{notes > 0 ? `${notes} meaningful agent updates` : "Forming an approach"}</span>
        </div>
      </div>
      <div
        className="overview-step"
        data-state={openDecisions > 0 ? "active" : sessionState.decisionCount > 0 ? "complete" : "quiet"}
      >
        <span className="overview-node" />
        <div>
          <strong>Decisions</strong>
          <span>
            {openDecisions > 0
              ? `${openDecisions} waiting for you`
              : sessionState.decisionCount > 0
                ? `${sessionState.decisionCount} resolved`
                : "No decision requested"}
          </span>
        </div>
      </div>
      <div
        className="overview-step"
        data-state={sessionState.changeUnitCount > 0 ? "complete" : terminal ? "quiet" : "pending"}
      >
        <span className="overview-node" />
        <div>
          <strong>Changes</strong>
          <span>
            {sessionState.changeUnitCount > 0
              ? `${sessionState.changeUnitCount} captured`
              : "No changes captured yet"}
          </span>
        </div>
      </div>
      <div
        className="overview-step"
        data-state={verificationViews > 0 || terminal ? "complete" : "pending"}
      >
        <span className="overview-node" />
        <div>
          <strong>Outcome</strong>
          <span>
            {sessionState.state === "completed"
              ? "Ready for review"
              : sessionState.state === "failed"
                ? "Needs intervention"
                : verificationViews > 0
                  ? `${verificationViews} verification views`
                  : "Work in progress"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Spec E3: today's Overview, Conversation and Decisions content as one host-registered view. */
export function SurfacesView({ active }: ViewProps) {
  const surfaces = useSurfacesContext();
  const { manager, entries, events, sessionState } = surfaces;
  const [filter, setFilter] = useState<SurfacesFilter>("overview");
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setFilter("overview");
  }, [surfaces.sessionId]);

  // The SurfaceManager defers swaps while the reader is pointing at or using the surfaces.
  useEffect(() => {
    if (root === null) return undefined;
    const onPointerEnter = () => manager.setPointerInside(true);
    const onPointerLeave = () => manager.setPointerInside(false);
    const onInteract = () => manager.notifyInteraction();
    root.addEventListener("pointerenter", onPointerEnter);
    root.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("pointerdown", onInteract);
    root.addEventListener("wheel", onInteract);
    root.addEventListener("keydown", onInteract);
    return () => {
      manager.setPointerInside(false);
      root.removeEventListener("pointerenter", onPointerEnter);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("pointerdown", onInteract);
      root.removeEventListener("wheel", onInteract);
      root.removeEventListener("keydown", onInteract);
    };
  }, [manager, root]);

  const visibleEntries = useMemo(() => {
    if (filter === "decisions") return entries.filter((entry) => entry.meta.group === "decision");
    return filter === "overview" ? entries : [];
  }, [entries, filter]);

  const visibleEvents = useMemo(
    () => events.filter((event) => filter === "conversation" && isConversationEvent(event)).slice(-MAX_VISIBLE_EVENTS),
    [events, filter],
  );
  const openDecisions = entries.filter((entry) => entry.meta.group === "decision").length;

  return (
    <section className="surfaces-view" ref={setRoot} data-active={active ? "true" : "false"} aria-label="Surfaces">
      <nav className="workspace-tabs" aria-label="Surfaces views">
        <button type="button" aria-pressed={filter === "overview"} onClick={() => setFilter("overview")}>
          Overview
        </button>
        <button type="button" aria-pressed={filter === "conversation"} onClick={() => setFilter("conversation")}>
          Conversation <span>{events.filter(isConversationEvent).length}</span>
        </button>
        <button type="button" aria-pressed={filter === "decisions"} onClick={() => setFilter("decisions")}>
          Decisions <span>{openDecisions}</span>
        </button>
      </nav>
      <div className="session-scroll">
        {filter === "overview" && sessionState ? (
          <SessionOverview sessionState={sessionState} events={events} entries={entries} openDecisions={openDecisions} />
        ) : null}
        {visibleEvents.length === 0 && visibleEntries.length === 0 ? (
          <div className="activity-empty">
            <span className="activity-pulse" />
            <h2>{filter === "conversation" ? "No conversation yet" : "No decisions yet"}</h2>
            <p>
              {filter === "conversation"
                ? "Meaningful agent updates will appear here without tool or command noise."
                : "Jev will place decisions here when your input is needed."}
            </p>
          </div>
        ) : null}
        {visibleEvents.length > 0 ? (
          <div className="activity-feed" aria-live="polite">
            {visibleEvents.map((event) => (
              <ActivityEvent key={eventKey(event)} event={event} />
            ))}
          </div>
        ) : null}
        {visibleEntries.length > 0 ? (
          <div className="work-products">
            <div className="work-products-heading">
              <h2>{filter === "decisions" ? "Decisions to make" : "Generative views"}</h2>
              <span className="jev-view-label">Jev · {visibleEntries.length}</span>
            </div>
            {visibleEntries.map(({ surface, meta }) => (
              <article
                key={surface.id}
                className={`surface surface-${meta.group}`}
                data-surface-id={surface.id}
                data-pinned={surface.pinned ? "true" : "false"}
              >
                <div className="surface-chrome">
                  <div className="surface-heading">
                    <span className={`surface-kind surface-kind-${meta.group}`}>{meta.label}</span>
                    <span className="surface-title">{meta.title}</span>
                  </div>
                  <span className="surface-actions">
                    <button
                      type="button"
                      className={surface.pinned ? "active" : ""}
                      aria-pressed={surface.pinned}
                      onClick={() => surfaces.togglePin(surface.id)}
                    >
                      {surface.pinned ? "Kept" : "Keep"}
                    </button>
                    <button type="button" onClick={() => surfaces.dismiss(surface.id)}>
                      Dismiss
                    </button>
                  </span>
                </div>
                <div className="surface-content">
                  <JSONUIProvider registry={registry}>
                    <Renderer spec={surface.spec as unknown as Spec} registry={registry} />
                  </JSONUIProvider>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export const surfacesView: ViewDefinition = {
  kind: "surfaces",
  label: "Surfaces",
  icon: "view-surfaces",
  Component: SurfacesView,
};
