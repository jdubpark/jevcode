import type { TerminalProps } from "@jevcode/contracts";

export function Terminal({ props }: { props: TerminalProps }) {
  return (
    <div className="jevcode-terminal" data-testid="terminal">
      <div className="jevcode-terminal-title">{props.title ?? "Terminal"}</div>
      <pre className="jevcode-terminal-scrollback">
        {(props.lines ?? []).join("\n")}
      </pre>
      <div className="jevcode-terminal-note">
        Terminal placeholder: the live PTY terminal is mounted by the app
        shell.
      </div>
    </div>
  );
}
