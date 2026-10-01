import { Component, type CSSProperties, type ReactNode } from "react";

import { DiagnosticsContext } from "./session-context.js";
import styles from "./Shell.module.css";

export interface ErrorBoundaryProps {
  /** Region name, shown as "<region> failed to render". */
  region: string;
  children: ReactNode;
  /** A second way out, e.g. "Switch to Canvas". */
  action?: { label: string; onAction(): void };
  /** Default: report "<region>: <message>" to the Shell's diagnostics sink. */
  onError?(error: Error): void;
  /** For a boundary outside the Shell root, whose tokens the fallback must bring itself. */
  fallbackClassName?: string;
  fallbackStyle?: CSSProperties;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Per-region boundary (spec §7.11 Errors). The store is outside it, so selection survives a crash. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static contextType = DiagnosticsContext;
  declare context: React.ContextType<typeof DiagnosticsContext>;

  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    if (this.props.onError !== undefined) this.props.onError(error);
    else this.context.reportError(`${this.props.region}: ${error.message}`);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const { action, region } = this.props;
    return (
      <div
        role="alert"
        className={`${styles.boundary} ${this.props.fallbackClassName ?? ""}`}
        style={this.props.fallbackStyle}
      >
        <p className={styles.boundaryText}>{`${region} failed to render`}</p>
        <div className={styles.boundaryActions}>
          {action === undefined ? null : (
            <button type="button" className={styles.button} onClick={action.onAction}>
              {action.label}
            </button>
          )}
          <button type="button" className={styles.button} onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      </div>
    );
  }
}
