import { Component, type ReactNode } from "react";

import styles from "./Shell.module.css";

export interface ErrorBoundaryProps {
  /** Region name, shown as "<region> failed to render". */
  region: string;
  children: ReactNode;
  /** A second way out, e.g. "Switch to Canvas". */
  action?: { label: string; onAction(): void };
  onError?(error: Error): void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Per-region boundary (spec §7.11 Errors). The store is outside it, so selection survives a crash. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const { action, region } = this.props;
    return (
      <div role="alert" className={styles.boundary}>
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
