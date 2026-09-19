import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

import { getBridge } from "../bridge.js";

interface TerminalPanelProps {
  sessionId: string | null;
  repoPath: string | null;
}

export function TerminalPanel(props: TerminalPanelProps) {
  const bridge = getBridge();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef(props.sessionId);
  sessionRef.current = props.sessionId;

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      convertEol: true,
      scrollback: 5000,
      cursorBlink: true,
    });
    termRef.current = term;
    term.open(containerRef.current);

    const offData = bridge.on("terminal:data", (payload) => {
      if (payload.sessionId === sessionRef.current) {
        term.write(payload.data);
      }
    });

    const offInput = term.onData((data) => {
      const sessionId = sessionRef.current;
      if (sessionId) void bridge.terminal.input(sessionId, data);
    });

    const offResize = term.onResize(({ cols, rows }) => {
      const sessionId = sessionRef.current;
      if (sessionId) void bridge.terminal.resize(sessionId, cols, rows);
    });

    return () => {
      offData();
      offInput.dispose();
      offResize.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [bridge]);

  // Session switches: clear the buffer and refetch the new session's
  // scrollback instead of showing the previous session's output.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    if (props.sessionId) {
      void bridge.terminal
        .getScrollback(props.sessionId, 500)
        .then((lines) => {
          term.write(lines.join("\r\n"));
        })
        .catch((error: unknown) => {
          console.error("failed to fetch terminal scrollback", error);
        });
    }
  }, [bridge, props.sessionId]);

  return (
    <section className="terminal-panel">
      <div className="terminal-header">
        <span>Terminal{props.repoPath ? ` — ${props.repoPath}` : ""}</span>
        {!props.sessionId && (
          <span className="dim">No active session; the PTY starts with the first task.</span>
        )}
      </div>
      <div className="terminal-container" ref={containerRef} />
    </section>
  );
}
