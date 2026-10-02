import { NormalizedAgentEventSchema, type NormalizedAgentEvent } from "@jevcode/contracts";
import {
  SurfaceManager,
  useSurfaceManager,
  validateIncomingPatch,
  validateIncomingSpec,
} from "@jevcode/ui-catalog";
import type { SurfaceRecord } from "@jevcode/ui-catalog";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { JevcodeApi } from "../../shared/api.js";
import type { SessionStatePayload, UiSpecPatchPayload, UiSpecPayload } from "../payload-types.js";

export type SurfaceGroup = "change" | "decision" | "verification" | "detail";

export interface SurfaceMeta {
  group: SurfaceGroup;
  label: string;
  title: string;
}

export interface SurfaceEntry {
  surface: SurfaceRecord;
  meta: SurfaceMeta;
  updatedAt: number;
}

export const TERMINAL_SURFACE_ID = "terminal";

function slotForSurfaceId(surfaceId: string): "generative" | "raw" | "terminal" {
  if (surfaceId === TERMINAL_SURFACE_ID) return "terminal";
  if (surfaceId.startsWith("diff:") || surfaceId.startsWith("callsites:")) return "raw";
  return "generative";
}

export function eventKey(event: NormalizedAgentEvent): string {
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
  for (const event of [...current, ...incoming]) byKey.set(eventKey(event), event);
  return [...byKey.values()].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-160);
}

export function isConversationEvent(event: NormalizedAgentEvent): boolean {
  return (
    event.type === "agent_started" ||
    event.type === "agent_message" ||
    event.type === "agent_waiting" ||
    event.type === "agent_completed" ||
    event.type === "agent_failed"
  );
}

export function surfaceMeta(surface: SurfaceRecord): SurfaceMeta {
  const elements = Object.values(surface.spec.elements) as Array<{ type: string; props?: Record<string, unknown> }>;
  const root = surface.spec.elements[surface.spec.root] as { type: string; props?: Record<string, unknown> } | undefined;
  const hasType = (type: string) => elements.some((element) => element.type === type);
  const titleCandidate =
    root?.props?.["title"] ?? elements.find((element) => typeof element.props?.["title"] === "string")?.props?.["title"];
  const title = typeof titleCandidate === "string" ? titleCandidate : "Session detail";
  if (surface.id === "completion") return { group: "verification", label: "Completed", title };
  if (hasType("Decision") || surface.id.startsWith("decision:")) return { group: "decision", label: "Decision", title };
  if (hasType("FailureAnalysis")) return { group: "verification", label: "Needs attention", title };
  if (hasType("TestMatrix") || surface.id.startsWith("validation:")) return { group: "verification", label: "Verification", title };
  if (hasType("CodeDiff") || surface.id.startsWith("diff:")) return { group: "detail", label: "Code detail", title };
  return { group: "change", label: "Change", title };
}

export interface SessionSurfaces {
  sessionId: string | null;
  sessionState: SessionStatePayload | null;
  manager: SurfaceManager;
  entries: readonly SurfaceEntry[];
  events: readonly NormalizedAgentEvent[];
  recordedFiles: readonly string[];
  togglePin(surfaceId: string): void;
  dismiss(surfaceId: string): void;
}

/** The generative surfaces and agent activity of the shown session, restored from storage and kept live by pushes. */
export function useSessionSurfaces(bridge: JevcodeApi, sessionState: SessionStatePayload | null): SessionSurfaces {
  const sessionId = sessionState?.sessionId ?? null;
  const [manager, setManager] = useState(() => new SurfaceManager());
  const surfacesApi = useSurfaceManager(manager);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [events, setEvents] = useState<NormalizedAgentEvent[]>([]);
  const [recordedFiles, setRecordedFiles] = useState<string[]>([]);

  useEffect(() => {
    setManager(new SurfaceManager());
    setEvents([]);
    setRecordedFiles([]);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
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
              return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
            }),
          ),
        ]);
        const decisionStatuses = new Map<string, string>();
        for (const record of stored) {
          if (record.type !== "decision") continue;
          const id = record.payload["id"];
          const status = record.payload["status"];
          if (typeof id === "string" && typeof status === "string") decisionStatuses.set(id, status);
        }
        const snapshots = new Map<string, { surfaceId: string; spec: UiSpecPayload["spec"]; seq: number }>();
        for (const record of stored) {
          if (record.type !== "ui_snapshot") continue;
          const surfaceId = record.payload["surfaceId"];
          if (typeof surfaceId !== "string") continue;
          const validated = validateIncomingSpec(record.payload["spec"]);
          if (!validated.ok) continue;
          snapshots.set(surfaceId, { surfaceId, spec: validated.spec, seq: record.seq });
        }
        const eligible = [...snapshots.values()]
          .filter(
            (snapshot) =>
              !snapshot.surfaceId.startsWith("decision:") ||
              decisionStatuses.get(snapshot.surfaceId.slice("decision:".length)) === "open",
          )
          .sort((a, b) => a.seq - b.seq);
        const snapshot =
          [...eligible].reverse().find((candidate) => candidate.surfaceId !== "completion") ??
          eligible.find((candidate) => candidate.surfaceId === "completion");
        if (snapshot !== undefined) {
          manager.propose({ id: snapshot.surfaceId, spec: snapshot.spec, slot: slotForSurfaceId(snapshot.surfaceId) });
        }
      })
      .catch((error: unknown) => {
        console.error("failed to restore session activity", error);
      });
    const offEvent = bridge.on("agent:event", (event) => {
      if (event.sessionId === sessionId) setEvents((current) => mergeEvents(current, [event]));
    });
    const offChangeUnit = bridge.on("changeunit:upsert", (payload) => {
      if (payload.sessionId !== sessionId) return;
      setRecordedFiles((current) => [...new Set([...current, ...payload.changeUnit.files])]);
    });
    const offDecisionResolved = bridge.on("decision:resolved", (payload) => {
      if (payload.sessionId === sessionId) manager.dismiss(`decision:${payload.decisionId}`);
    });
    return () => {
      cancelled = true;
      offEvent();
      offChangeUnit();
      offDecisionResolved();
    };
  }, [bridge, manager, sessionId]);

  useEffect(() => {
    const accepts = (payloadSessionId: string) =>
      sessionIdRef.current === null || payloadSessionId === sessionIdRef.current;
    const offSpec = bridge.on("ui:spec", (payload: UiSpecPayload) => {
      if (!accepts(payload.sessionId)) return;
      const validated = validateIncomingSpec(payload.spec);
      if (!validated.ok) {
        console.error(`dropping invalid ui:spec for ${payload.surfaceId}: ${validated.error}`);
        return;
      }
      manager.propose({ id: payload.surfaceId, spec: validated.spec, slot: slotForSurfaceId(payload.surfaceId) });
    });
    const offPatch = bridge.on("ui:specPatch", (payload: UiSpecPatchPayload) => {
      if (!accepts(payload.sessionId)) return;
      const validated = validateIncomingPatch(payload.patch);
      if (!validated.ok) {
        console.error(`dropping invalid ui:specPatch for ${payload.surfaceId}: ${validated.error}`);
        return;
      }
      manager.applyPatch(payload.surfaceId, validated.patch);
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
        .map((surface) => ({ surface, meta: surfaceMeta(surface), updatedAt: surface.createdAt }))
        .sort((a, b) => a.updatedAt - b.updatedAt),
    [surfacesApi.generative, surfacesApi.raws],
  );

  return useMemo(
    () => ({ sessionId, sessionState, manager, entries, events, recordedFiles, togglePin, dismiss }),
    [sessionId, sessionState, manager, entries, events, recordedFiles, togglePin, dismiss],
  );
}

export const SurfacesContext = createContext<SessionSurfaces | null>(null);

export function useSurfacesContext(): SessionSurfaces {
  const surfaces = useContext(SurfacesContext);
  if (surfaces === null) throw new Error("SurfacesView must render inside SurfacesContext");
  return surfaces;
}
