import { useEffect, useState } from "react";

import type { AgentInstructionStatePayload } from "../../shared/api.js";
import type {
  LocalTelemetryEvent,
  StoredEventSummary,
} from "../../shared/local-channels.js";
import { getBridge } from "../bridge.js";

type DebugTab = "events" | "jev" | "logs" | "telemetry" | "instructions";

interface DebugPanelProps {
  sessionId: string | undefined;
  onClose: () => void;
}

export function DebugPanel(props: DebugPanelProps) {
  const [tab, setTab] = useState<DebugTab>("events");

  const tabs: { id: DebugTab; label: string }[] = [
    { id: "events", label: "Events" },
    { id: "jev", label: "Jev" },
    { id: "logs", label: "Logs" },
    { id: "telemetry", label: "Telemetry" },
    { id: "instructions", label: "Instructions" },
  ];

  return (
    <div className="debug-panel">
      <div className="debug-header">
        <div className="debug-tabs">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? "active" : ""}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="debug-body">
        {tab === "events" && <EventsTab sessionId={props.sessionId} />}
        {tab === "jev" && <JevTab sessionId={props.sessionId} />}
        {tab === "logs" && <LogsTab sessionId={props.sessionId} />}
        {tab === "telemetry" && <TelemetryTab sessionId={props.sessionId} />}
        {tab === "instructions" && <InstructionsTab sessionId={props.sessionId} />}
      </div>
    </div>
  );
}

function EventsTab({ sessionId }: { sessionId: string | undefined }) {
  const bridge = getBridge();
  const [events, setEvents] = useState<StoredEventSummary[] | null>(null);
  const [liveCount, setLiveCount] = useState(0);

  useEffect(() => {
    const refresh = () => {
      void bridge.debug.listEvents(sessionId, 200).then(setEvents);
    };
    refresh();
    const offAgent = bridge.on("agent:event", (event) => {
      if (!sessionId || event.sessionId === sessionId) {
        setLiveCount((n) => n + 1);
      }
    });
    return () => {
      offAgent();
    };
  }, [bridge, sessionId]);

  if (!events) return <p className="dim">Loading events…</p>;
  if (events.length === 0) return <p className="dim">No events yet.</p>;
  return (
    <div>
      <p>
        {events.length} stored events ({liveCount} live since open).
      </p>
      <table className="debug-table">
        <thead>
          <tr>
            <th>seq</th>
            <th>type</th>
            <th>ts</th>
            <th>summary</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{event.seq}</td>
              <td>{event.type}</td>
              <td>{event.ts}</td>
              <td>{summarizeEvent(event)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarizeEvent(event: StoredEventSummary): string {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "agent_event") {
    return `${String(payload["type"] ?? "")}`;
  }
  if (event.type === "evidence_fact") {
    return `${String(payload["type"] ?? "")} ${String(payload["path"] ?? payload["file"] ?? payload["manifest"] ?? payload["command"] ?? "")}`;
  }
  if (event.type === "change_unit") {
    return String(payload["title"] ?? "");
  }
  if (event.type === "decision") {
    return `${String(payload["title"] ?? "")} [${String(payload["status"] ?? "")}]`;
  }
  if (event.type === "jev_decision") {
    return `${String(payload["clientKind"] ?? "")} conf=${String(payload["confidence"] ?? "")}`;
  }
  if (event.type === "validation") {
    return `${String(payload["command"] ?? "")} ${String(payload["status"] ?? "")}`;
  }
  if (event.type === "ui_snapshot") {
    return String(payload["surfaceId"] ?? "");
  }
  return "";
}

function JevTab({ sessionId }: { sessionId: string | undefined }) {
  const bridge = getBridge();
  const [decisions, setDecisions] = useState<Record<string, unknown>[] | null>(null);
  const [liveCount, setLiveCount] = useState(0);

  useEffect(() => {
    const refresh = () => {
      void bridge.debug.listJevDecisions(sessionId, 50).then(setDecisions);
    };
    refresh();
    const offJev = bridge.on("jev:debug", (payload) => {
      if (!sessionId || payload.sessionId === sessionId) {
        setLiveCount(payload.decisions.length);
      }
    });
    return () => {
      offJev();
    };
  }, [bridge, sessionId]);

  if (!decisions) return <p className="dim">Loading Jev decisions…</p>;
  if (decisions.length === 0) return <p className="dim">No Jev decisions logged yet.</p>;
  return (
    <div>
      <p>
        {decisions.length} Jev decisions stored ({liveCount} in latest push).
      </p>
      <table className="debug-table">
        <thead>
          <tr>
            <th>client</th>
            <th>confidence</th>
            <th>latency</th>
            <th>clamps</th>
            <th>unit</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((log) => (
            <tr key={String(log["id"] ?? `${String(log["inputHash"])}-${String(log["ts"])}`)}>
              <td>{String(log["clientKind"] ?? "")}</td>
              <td>{String(log["confidence"] ?? "")}</td>
              <td>{String(log["latencyMs"] ?? "")}ms</td>
              <td>{JSON.stringify(log["clamps"] ?? [])}</td>
              <td>{String(log["changeUnitId"] ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogsTab({ sessionId }: { sessionId: string | undefined }) {
  const bridge = getBridge();
  const [events, setEvents] = useState<StoredEventSummary[] | null>(null);

  useEffect(() => {
    void bridge.debug
      .listEvents(sessionId, 500)
      .then((all) =>
        setEvents(
          all.filter(
            (event) =>
              event.type === "agent_event" &&
              (event.payload["type"] === "agent_message" ||
                event.payload["type"] === "command_completed" ||
                event.payload["type"] === "agent_failed" ||
                event.payload["type"] === "agent_completed"),
          ),
        ),
      )
      .catch((error: unknown) => {
        console.error("failed to list logs", error);
      });
  }, [bridge, sessionId]);

  if (!events) return <p className="dim">Loading logs…</p>;
  if (events.length === 0) return <p className="dim">No agent log lines yet.</p>;
  return (
    <div className="debug-logs">
      {events.map((event) => (
        <pre key={event.id}>
          {event.ts} [{String(event.payload["type"])}]{" "}
          {String(
            event.payload["text"] ??
              event.payload["command"] ??
              event.payload["error"] ??
              "",
          )}
        </pre>
      ))}
    </div>
  );
}

function TelemetryTab({ sessionId }: { sessionId: string | undefined }) {
  const bridge = getBridge();
  const [events, setEvents] = useState<LocalTelemetryEvent[] | null>(null);

  useEffect(() => {
    void bridge.debug
      .listTelemetry(sessionId, 200)
      .then(setEvents)
      .catch((error: unknown) => {
        console.error("failed to list telemetry", error);
      });
  }, [bridge, sessionId]);

  if (!events) return <p className="dim">Loading telemetry…</p>;
  if (events.length === 0) return <p className="dim">No telemetry events yet.</p>;

  return (
    <table className="telemetry-table">
      <thead>
        <tr>
          <th>type</th>
          <th>ts</th>
          <th>payload</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <tr key={event.id ?? `${event.type}-${event.ts}`}>
            <td>{event.type}</td>
            <td>{event.ts}</td>
            <td className="telemetry-payload">{JSON.stringify(event.payload)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InstructionsTab({ sessionId }: { sessionId: string | undefined }) {
  const bridge = getBridge();
  const [pending, setPending] = useState<AgentInstructionStatePayload["pending"] | null>(null);

  useEffect(() => {
    setPending(null);
    const off = bridge.onInstructionState((payload) => {
      if (!sessionId || payload.sessionId === sessionId) {
        setPending(payload.pending);
      }
    });
    return () => {
      off();
    };
  }, [bridge, sessionId]);

  if (pending === null) {
    return <p className="dim">Waiting for instruction state…</p>;
  }
  if (pending.length === 0) {
    return <p className="dim">No pending instructions.</p>;
  }
  return (
    <table className="debug-table">
      <thead>
        <tr>
          <th>id</th>
          <th>mode</th>
          <th>createdAt</th>
          <th>text</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {pending.map((instruction) => (
          <tr key={instruction.id}>
            <td>{instruction.id}</td>
            <td>{instruction.mode}</td>
            <td>{instruction.createdAt}</td>
            <td>{instruction.text}</td>
            <td>
              <button
                type="button"
                onClick={() => {
                  if (sessionId) {
                    void bridge.agent.cancelInstruction(
                      sessionId,
                      instruction.id,
                    );
                  }
                }}
              >
                Cancel
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
