import { Renderer, JSONUIProvider } from "@json-render/react";
import type { Spec } from "@json-render/core";
import {
  registry,
  setActionDispatcher,
  SurfaceManager,
  useSurfaceManager,
  validateIncomingPatch,
  validateIncomingSpec,
} from "@jevcode/ui-catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  SessionStatePayload,
  UiSpecPatchPayload,
  UiSpecPayload,
} from "../payload-types.js";

import { getBridge } from "../bridge.js";

interface WorkspaceHostProps {
  sessionState: SessionStatePayload | null;
}

const TERMINAL_SURFACE_ID = "terminal";

function slotForSurfaceId(surfaceId: string): "generative" | "raw" | "terminal" {
  if (surfaceId === TERMINAL_SURFACE_ID) return "terminal";
  if (surfaceId.startsWith("diff:") || surfaceId.startsWith("callsites:")) {
    return "raw";
  }
  return "generative";
}

export function WorkspaceHost(props: WorkspaceHostProps) {
  const bridge = getBridge();
  const sessionId = props.sessionState?.sessionId ?? null;
  const [manager, setManager] = useState(() => new SurfaceManager());
  const surfacesApi = useSurfaceManager(manager);
  const sessionRef = useRef(props.sessionState);
  sessionRef.current = props.sessionState;
  const [workspaceEl, setWorkspaceEl] = useState<HTMLElement | null>(null);
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

  // One manager per session: switching sessions discards the previous
  // session's surfaces entirely.
  useEffect(() => {
    setManager(new SurfaceManager());
  }, [sessionId]);

  // Interaction lock wiring from the workspace DOM: pointer presence and
  // recent interactions hold off surface replacement.
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
    const offSpec = bridge.on("ui:spec", (payload: UiSpecPayload) => {
      if (!sessionRef.current || payload.sessionId === sessionRef.current.sessionId) {
        // Closed-catalog validation: specs whose components are not in the
        // SPEC 9.2 catalog are dropped and logged, never rendered.
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
      if (pinned) {
        manager.unpin(surfaceId);
      } else {
        manager.pin(surfaceId);
      }
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

  const entries = useMemo(() => {
    return [
      ...surfacesApi.generative.map((surface) => ({ surface, updatedAt: surface.createdAt })),
      ...surfacesApi.raws.map((surface) => ({ surface, updatedAt: surface.createdAt })),
    ].sort((a, b) => a.updatedAt - b.updatedAt);
  }, [surfacesApi.generative, surfacesApi.raws]);

  if (entries.length === 0) {
    return (
      <section className="workspace" ref={workspaceRef}>
        <div className="workspace-empty">
          <p className="dim">
            Generative workspace: no surface yet. Start a task or replay a fixture to see
            semantic UI rendered here.
          </p>
          {props.sessionState && (
            <p className="dim">
              Session {props.sessionState.sessionId} is {props.sessionState.state}.
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="workspace" ref={workspaceRef}>
      {entries.map(({ surface }) => (
        <div
          key={surface.id}
          className="surface"
          data-surface-id={surface.id}
          data-pinned={surface.pinned ? "true" : "false"}
        >
          <div className="surface-chrome">
            <span className="surface-id">{surface.id}</span>
            <span className="surface-actions">
              <button
                type="button"
                className={surface.pinned ? "active" : ""}
                onClick={() => togglePin(surface.id)}
              >
                {surface.pinned ? "Unpin" : "Pin"}
              </button>
              <button type="button" onClick={() => dismiss(surface.id)}>
                Dismiss
              </button>
            </span>
          </div>
          <JSONUIProvider registry={registry}>
            <Renderer spec={surface.spec as unknown as Spec} registry={registry} />
          </JSONUIProvider>
        </div>
      ))}
    </section>
  );
}
