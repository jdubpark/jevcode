import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import {
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "@jevcode/contracts";
import {
  registry,
  setActionDispatcher,
  SurfaceManager,
  useSurfaceManager,
  validateIncomingPatch,
  validateIncomingSpec,
} from "@jevcode/ui-catalog";
import type { SurfaceRecord } from "@jevcode/ui-catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentInstructionStatePayload } from "../../shared/api.js";
import { getBridge } from "../bridge.js";
import type {
  RepoOpenedPayload,
  SessionStatePayload,
  UiSpecPatchPayload,
  UiSpecPayload,
} from "../payload-types.js";
import { TaskPrompt } from "./TaskPrompt.js";

interface WorkspaceHostProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
  activePrompt: string;
  agentLine: string;
  onStart: (prompt: string) => void | Promise<void>;
}

type WorkspaceFilter = "overview" | "conversation" | "decisions";
type InstructionMode = "steer" | "queue";
type SurfaceGroup = "change" | "decision" | "verification" | "detail";

interface SurfaceMeta {
  group: SurfaceGroup;
  label: string;
  title: string;
}

const TERMINAL_SURFACE_ID = "terminal";
const MAX_VISIBLE_EVENTS = 80;

function slotForSurfaceId(surfaceId: string): "generative" | "raw" | "terminal" {
  if (surfaceId === TERMINAL_SURFACE_ID) return "terminal";
  if (surfaceId.startsWith("diff:") || surfaceId.startsWith("callsites:")) {
    return "raw";
  }
  return "generative";
}

function eventKey(event: NormalizedAgentEvent): string {
  const detail =
    event.type === "agent_message"
      ? `${event.role}:${event.text}`
      : event.type === "command_started" || event.type === "command_completed"
        ? event.command
        : event.type === "tool_started" || event.type === "tool_completed"
          ? event.tool
          : event.type === "file_read" || event.type === "file_changed"
            ? event.path
            : event.type === "test_started" || event.type === "test_completed"
              ? event.command
              : event.type === "agent_failed"
                ? event.error
                : event.type;
  return `${event.ts}:${event.type}:${detail}`;
}

function mergeEvents(
  current: readonly NormalizedAgentEvent[],
  incoming: readonly NormalizedAgentEvent[],
): NormalizedAgentEvent[] {
  const byKey = new Map<string, NormalizedAgentEvent>();
  for (const event of [...current, ...incoming]) {
    byKey.set(eventKey(event), event);
  }
  return [...byKey.values()]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-160);
}

function readable(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortToolName(value: string): string {
  const parts = value.split(".");
  return readable(parts[parts.length - 1] ?? value);
}

function shortPath(value: string): string {
  const parts = value.split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function eventSummary(event: NormalizedAgentEvent): string {
  switch (event.type) {
    case "agent_started":
      return "Started working on the task";
    case "agent_message":
      return event.role === "user" ? "Direction received" : event.text;
    case "tool_started":
      return `Using ${shortToolName(event.tool)}`;
    case "tool_completed":
      return `Finished ${shortToolName(event.tool)}`;
    case "command_started":
      return `Running ${event.command}`;
    case "command_completed":
      return `${event.command} finished with exit ${event.exitCode}`;
    case "file_read":
      return `Reading ${shortPath(event.path)}`;
    case "file_changed":
      return `Changed ${shortPath(event.path)}`;
    case "approval_requested":
      return `Approval needed for ${event.command}`;
    case "test_started":
      return `Checking with ${event.command}`;
    case "test_completed":
      return `${event.command} ${event.exitCode === 0 ? "passed" : "failed"}`;
    case "agent_waiting":
      return "Waiting for direction";
    case "agent_completed":
      return "Task completed";
    case "agent_failed":
      return `Stopped: ${event.error}`;
  }
}

function isConversationEvent(event: NormalizedAgentEvent): boolean {
  return (
    event.type === "agent_started" ||
    event.type === "agent_message" ||
    event.type === "agent_waiting" ||
    event.type === "agent_completed" ||
    event.type === "agent_failed"
  );
}

function surfaceMeta(surface: SurfaceRecord): SurfaceMeta {
  const elements = Object.values(surface.spec.elements) as Array<{
    type: string;
    props?: Record<string, unknown>;
  }>;
  const root = surface.spec.elements[surface.spec.root] as
    | { type: string; props?: Record<string, unknown> }
    | undefined;
  const hasType = (type: string) => elements.some((element) => element.type === type);
  const titleCandidate =
    root?.props?.["title"] ??
    elements.find((element) => typeof element.props?.["title"] === "string")?.props?.[
      "title"
    ];
  const title = typeof titleCandidate === "string" ? titleCandidate : "Session detail";

  if (surface.id === "completion") {
    return { group: "verification", label: "Completed", title };
  }
  if (hasType("Decision") || surface.id.startsWith("decision:")) {
    return { group: "decision", label: "Decision", title };
  }
  if (hasType("FailureAnalysis")) {
    return { group: "verification", label: "Needs attention", title };
  }
  if (hasType("TestMatrix") || surface.id.startsWith("validation:")) {
    return { group: "verification", label: "Verification", title };
  }
  if (hasType("CodeDiff") || surface.id.startsWith("diff:")) {
    return { group: "detail", label: "Code detail", title };
  }
  return { group: "change", label: "Change", title };
}

function statusLabel(state: SessionStatePayload["state"]): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "waiting_decision":
      return "Needs your decision";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Stopped with an error";
  }
}

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
            <time>{formatTime(event.ts)}</time>
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
            <time>{formatTime(event.ts)}</time>
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
          <span>{eventSummary(event)}</span>
          <time>{formatTime(event.ts)}</time>
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
  events: NormalizedAgentEvent[];
  entries: Array<{ meta: SurfaceMeta }>;
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

export function WorkspaceHost(props: WorkspaceHostProps) {
  const bridge = getBridge();
  const sessionId = props.sessionState?.sessionId ?? null;
  const [manager, setManager] = useState(() => new SurfaceManager());
  const surfacesApi = useSurfaceManager(manager);
  const sessionRef = useRef(props.sessionState);
  sessionRef.current = props.sessionState;
  const [workspaceEl, setWorkspaceEl] = useState<HTMLElement | null>(null);
  const [events, setEvents] = useState<NormalizedAgentEvent[]>([]);
  const [recordedFiles, setRecordedFiles] = useState<string[]>([]);
  const [pending, setPending] = useState<AgentInstructionStatePayload["pending"]>([]);
  const [filter, setFilter] = useState<WorkspaceFilter>("overview");
  const [instructionMode, setInstructionMode] = useState<InstructionMode>("steer");
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const workspaceRef = useCallback((element: HTMLElement | null) => {
    setWorkspaceEl(element);
  }, []);

  useEffect(() => {
    setActionDispatcher((action, params) => {
      void bridge.action.invoke(action, params);
    });
    return () => {
      setActionDispatcher(undefined);
    };
  }, [bridge]);

  useEffect(() => {
    setManager(new SurfaceManager());
    setEvents([]);
    setRecordedFiles([]);
    setPending([]);
    setFilter("overview");
    setInstruction("");
    setActionError(null);
  }, [sessionId]);

  useEffect(() => {
    const element = workspaceEl;
    if (!element) return;
    const onPointerEnter = () => manager.setPointerInside(true);
    const onPointerLeave = () => manager.setPointerInside(false);
    const onInteract = () => manager.notifyInteraction();
    element.addEventListener("pointerenter", onPointerEnter);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("pointerdown", onInteract);
    element.addEventListener("wheel", onInteract);
    element.addEventListener("keydown", onInteract);
    return () => {
      element.removeEventListener("pointerenter", onPointerEnter);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("pointerdown", onInteract);
      element.removeEventListener("wheel", onInteract);
      element.removeEventListener("keydown", onInteract);
    };
  }, [manager, workspaceEl]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void bridge.debug
      .listEvents(sessionId, 2000)
      .then((stored) => {
        if (cancelled) return;
        const restored = stored.flatMap((record) => {
          if (record.type !== "agent_event") return [];
          const parsed = NormalizedAgentEventSchema.safeParse(record.payload);
          return parsed.success ? [parsed.data] : [];
        });
        setEvents((current) => mergeEvents(restored, current));
        setRecordedFiles([
          ...new Set(
            stored.flatMap((record) => {
              if (record.type !== "change_unit") return [];
              const files = record.payload["files"];
              return Array.isArray(files)
                ? files.filter((file): file is string => typeof file === "string")
                : [];
            }),
          ),
        ]);
        const decisionStatuses = new Map<string, string>();
        for (const record of stored) {
          if (record.type !== "decision") continue;
          const id = record.payload["id"];
          const status = record.payload["status"];
          if (typeof id === "string" && typeof status === "string") {
            decisionStatuses.set(id, status);
          }
        }
        const snapshots = new Map<
          string,
          { surfaceId: string; spec: UiSpecPayload["spec"]; seq: number }
        >();
        for (const record of stored) {
          if (record.type !== "ui_snapshot") continue;
          const surfaceId = record.payload["surfaceId"];
          const spec = record.payload["spec"];
          if (typeof surfaceId !== "string") continue;
          const validated = validateIncomingSpec(spec);
          if (!validated.ok) continue;
          snapshots.set(surfaceId, { surfaceId, spec: validated.spec, seq: record.seq });
        }
        const eligibleSnapshots = [...snapshots.values()]
          .filter(
            (snapshot) =>
              !snapshot.surfaceId.startsWith("decision:") ||
              decisionStatuses.get(snapshot.surfaceId.slice("decision:".length)) === "open",
          )
          .sort((a, b) => a.seq - b.seq);
        const snapshot =
          [...eligibleSnapshots]
            .reverse()
            .find((candidate) => candidate.surfaceId !== "completion") ??
          eligibleSnapshots.find((candidate) => candidate.surfaceId === "completion");
        if (snapshot !== undefined) {
          manager.propose({
            id: snapshot.surfaceId,
            spec: snapshot.spec,
            slot: slotForSurfaceId(snapshot.surfaceId),
          });
        }
      })
      .catch((error: unknown) => {
        console.error("failed to restore session activity", error);
      });
    const offEvent = bridge.on("agent:event", (event) => {
      if (event.sessionId === sessionId) {
        setEvents((current) => mergeEvents(current, [event]));
      }
    });
    const offInstructions = bridge.onInstructionState((instructionState) => {
      if (instructionState.sessionId === sessionId) setPending(instructionState.pending);
    });
    const offChangeUnit = bridge.on("changeunit:upsert", (payload) => {
      if (payload.sessionId !== sessionId) return;
      setRecordedFiles((current) => [
        ...new Set([...current, ...payload.changeUnit.files]),
      ]);
    });
    const offDecisionResolved = bridge.on("decision:resolved", (payload) => {
      if (payload.sessionId === sessionId) {
        manager.dismiss(`decision:${payload.decisionId}`);
      }
    });
    return () => {
      cancelled = true;
      offEvent();
      offInstructions();
      offChangeUnit();
      offDecisionResolved();
    };
  }, [bridge, manager, sessionId]);

  useEffect(() => {
    const offSpec = bridge.on("ui:spec", (payload: UiSpecPayload) => {
      if (!sessionRef.current || payload.sessionId === sessionRef.current.sessionId) {
        const validated = validateIncomingSpec(payload.spec);
        if (!validated.ok) {
          console.error(
            `dropping invalid ui:spec for ${payload.surfaceId}: ${validated.error}`,
          );
          return;
        }
        manager.propose({
          id: payload.surfaceId,
          spec: validated.spec,
          slot: slotForSurfaceId(payload.surfaceId),
        });
      }
    });
    const offPatch = bridge.on("ui:specPatch", (payload: UiSpecPatchPayload) => {
      if (!sessionRef.current || payload.sessionId === sessionRef.current.sessionId) {
        const validated = validateIncomingPatch(payload.patch);
        if (!validated.ok) {
          console.error(
            `dropping invalid ui:specPatch for ${payload.surfaceId}: ${validated.error}`,
          );
          return;
        }
        manager.applyPatch(payload.surfaceId, validated.patch);
      }
    });
    return () => {
      offSpec();
      offPatch();
    };
  }, [bridge, manager]);

  const togglePin = useCallback(
    (surfaceId: string) => {
      const record =
        surfacesApi.generative.find((surface) => surface.id === surfaceId) ??
        surfacesApi.raws.find((surface) => surface.id === surfaceId);
      const pinned = record?.pinned ?? false;
      void bridge.surface.pin(surfaceId, !pinned);
      if (pinned) manager.unpin(surfaceId);
      else manager.pin(surfaceId);
    },
    [bridge, manager, surfacesApi.generative, surfacesApi.raws],
  );

  const dismiss = useCallback(
    (surfaceId: string) => {
      void bridge.surface.dismiss(surfaceId);
      manager.dismiss(surfaceId);
    },
    [bridge, manager],
  );

  const entries = useMemo(
    () =>
      [...surfacesApi.generative, ...surfacesApi.raws]
        .map((surface) => ({
          surface,
          meta: surfaceMeta(surface),
          updatedAt: surface.createdAt,
        }))
        .sort((a, b) => a.updatedAt - b.updatedAt),
    [surfacesApi.generative, surfacesApi.raws],
  );

  const visibleEntries = useMemo(() => {
    if (filter === "decisions") {
      return entries.filter((entry) => entry.meta.group === "decision");
    }
    return filter === "overview" ? entries : [];
  }, [entries, filter]);

  const visibleEvents = useMemo(() => {
    const selected = events.filter((event) => {
      return filter === "conversation" && isConversationEvent(event);
    });
    return selected.slice(-MAX_VISIBLE_EVENTS);
  }, [events, filter]);

  const changedFiles = useMemo(() => {
    const files = new Set<string>(recordedFiles);
    for (const event of events) {
      if (event.type === "file_changed") files.add(event.path);
    }
    for (const entry of entries) {
      for (const element of Object.values(entry.surface.spec.elements) as Array<{
        props?: Record<string, unknown>;
      }>) {
        const file = element.props?.["file"];
        if (typeof file === "string") files.add(file);
        const elementFiles = element.props?.["files"];
        if (Array.isArray(elementFiles)) {
          for (const item of elementFiles) if (typeof item === "string") files.add(item);
        }
      }
    }
    return [...files];
  }, [entries, events, recordedFiles]);

  const latestAssistant = [...events]
    .reverse()
    .find((event) => event.type === "agent_message" && event.role === "assistant");
  const latestEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "agent_message" ||
        event.type === "file_changed" ||
        event.type === "test_completed" ||
        event.type === "agent_waiting" ||
        event.type === "agent_completed" ||
        event.type === "agent_failed",
    );
  const openDecisions = entries.filter((entry) => entry.meta.group === "decision").length;
  const state = props.sessionState?.state;

  const sendInstruction = async () => {
    const text = instruction.trim();
    if (!sessionId || text.length === 0 || sending) return;
    setSending(true);
    setActionError(null);
    try {
      const shouldResume = state === "completed" || state === "paused" || state === "failed";
      await bridge.agent.sendInstruction(
        sessionId,
        text,
        shouldResume ? "queue" : instructionMode,
      );
      if (shouldResume) await bridge.agent.resume(sessionId);
      setInstruction("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const toggleAgent = async () => {
    if (!sessionId || !state) return;
    setActionError(null);
    try {
      if (state === "running" || state === "starting") {
        await bridge.agent.interrupt(sessionId);
      } else if (state === "paused") {
        await bridge.agent.resume(sessionId);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  if (props.activePrompt.trim().length === 0) {
    return (
      <section className="workspace workspace-onboarding" ref={workspaceRef}>
        <TaskPrompt
          repo={props.repo}
          agentLine={props.agentLine}
          onSubmit={props.onStart}
        />
      </section>
    );
  }

  return (
    <section className="workspace workspace-session" ref={workspaceRef}>
      <div className="session-main">
        <header className="session-heading">
          <div>
            <div className="session-title-line">
              <h1>Agent workspace</h1>
              {state ? (
                <span className={`session-state session-state-${state}`}>
                  <span className="session-state-dot" />
                  {statusLabel(state)}
                </span>
              ) : null}
            </div>
            <p>{props.activePrompt}</p>
          </div>
          {state === "running" || state === "starting" || state === "paused" ? (
            <button type="button" className="quiet-button" onClick={() => void toggleAgent()}>
              {state === "paused" ? "Resume" : "Pause"}
            </button>
          ) : null}
        </header>

        <nav className="workspace-tabs" aria-label="Workspace views">
          <button
            type="button"
            aria-pressed={filter === "overview"}
            onClick={() => setFilter("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            aria-pressed={filter === "conversation"}
            onClick={() => setFilter("conversation")}
          >
            Conversation <span>{events.filter(isConversationEvent).length}</span>
          </button>
          <button
            type="button"
            aria-pressed={filter === "decisions"}
            onClick={() => setFilter("decisions")}
          >
            Decisions <span>{openDecisions}</span>
          </button>
        </nav>

        <div className="session-scroll">
          {filter === "overview" && props.sessionState ? (
            <SessionOverview
              sessionState={props.sessionState}
              events={events}
              entries={entries}
              openDecisions={openDecisions}
            />
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
                      <span className={`surface-kind surface-kind-${meta.group}`}>
                        {meta.label}
                      </span>
                      <span className="surface-title">{meta.title}</span>
                    </div>
                    <span className="surface-actions">
                      <button
                        type="button"
                        className={surface.pinned ? "active" : ""}
                        aria-pressed={surface.pinned}
                        onClick={() => togglePin(surface.id)}
                      >
                        {surface.pinned ? "Kept" : "Keep"}
                      </button>
                      <button type="button" onClick={() => dismiss(surface.id)}>
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

        <div className="session-composer">
          <textarea
            aria-label="Guide the agent"
            placeholder={
              state === "completed"
                ? "Ask for a follow-up or revision…"
                : "Redirect, add a constraint, or ask what the agent is doing…"
            }
            value={instruction}
            disabled={!sessionId || sending}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendInstruction();
              }
            }}
          />
          <div className="session-composer-footer">
            {state === "completed" || state === "paused" || state === "failed" ? (
              <span className="composer-hint">This will continue the session</span>
            ) : (
              <div className="instruction-modes" aria-label="Instruction timing">
                <button
                  type="button"
                  aria-pressed={instructionMode === "steer"}
                  onClick={() => setInstructionMode("steer")}
                >
                  Steer now
                </button>
                <button
                  type="button"
                  aria-pressed={instructionMode === "queue"}
                  onClick={() => setInstructionMode("queue")}
                >
                  Queue next
                </button>
              </div>
            )}
            <div className="composer-submit">
              <span className="task-shortcut">⌘ ↵</span>
              <button
                type="button"
                className="primary-button"
                disabled={!sessionId || instruction.trim().length === 0 || sending}
                onClick={() => void sendInstruction()}
              >
                {sending
                  ? "Sending…"
                  : state === "completed" || state === "paused" || state === "failed"
                    ? "Continue"
                    : instructionMode === "steer"
                      ? "Steer agent"
                      : "Add to queue"}
              </button>
            </div>
          </div>
          {actionError !== null ? (
            <p className="form-error" role="alert">{actionError}</p>
          ) : null}
        </div>
      </div>

      <aside className="context-rail" aria-label="Live session context">
        <section>
          <h2>Current context</h2>
          <div className="context-now">
            <span className="context-now-label">Now</span>
            <p>
              {state === "completed"
                ? "Work is complete and ready for review or a follow-up."
                : latestEvent
                  ? eventSummary(latestEvent)
                  : "Preparing the session"}
            </p>
          </div>
          {latestAssistant?.type === "agent_message" ? (
            <div className="context-thinking">
              <span>Agent is considering</span>
              <p>{latestAssistant.text}</p>
            </div>
          ) : null}
        </section>

        <section>
          <h2>Session map</h2>
          <dl className="context-stats">
            <div>
              <dt>Changes</dt>
              <dd>{props.sessionState?.changeUnitCount ?? 0}</dd>
            </div>
            <div>
              <dt>Decisions</dt>
              <dd>{props.sessionState?.decisionCount ?? 0}</dd>
            </div>
            <div>
              <dt>Files touched</dt>
              <dd>{changedFiles.length}</dd>
            </div>
          </dl>
        </section>

        {changedFiles.length > 0 ? (
          <section>
            <h2>Files in play</h2>
            <ul className="context-files">
              {changedFiles.slice(0, 8).map((file) => (
                <li key={file} title={file}>{shortPath(file)}</li>
              ))}
            </ul>
            {changedFiles.length > 8 ? (
              <button type="button" className="context-more" onClick={() => setFilter("overview")}>
                View session overview
              </button>
            ) : null}
          </section>
        ) : null}

        <section>
          <h2>Instruction queue</h2>
          {pending.length === 0 ? (
            <p className="context-empty">Nothing waiting. New direction can be sent immediately.</p>
          ) : (
            <ul className="instruction-queue">
              {pending.map((item) => (
                <li key={item.id}>
                  <span className="instruction-mode">{item.mode === "steer" ? "Steer" : "Next"}</span>
                  <p>{item.text}</p>
                  <button
                    type="button"
                    onClick={() => void bridge.agent.cancelInstruction(sessionId ?? "", item.id)}
                  >
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </section>
  );
}
