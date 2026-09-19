import type { FailureAnalysisProps } from "@jevcode/contracts";

import { ActionButtons } from "./ActionButtons.js";

export function FailureAnalysis({ props }: { props: FailureAnalysisProps }) {
  return (
    <div className="jevcode-failure-analysis" data-testid="failure-analysis">
      <h3 className="jevcode-title">{props.title}</h3>
      <div className="jevcode-command">
        <code>{props.command}</code>
        <span className="jevcode-runner" data-runner={props.runner}>
          {props.runner}
        </span>
        <span className="jevcode-exit-code" data-exit-code={props.exitCode}>
          exit {props.exitCode}
        </span>
      </div>
      <ul className="jevcode-failures" data-testid="failures">
        {props.failures.map((failure, index) => (
          <li key={index} data-testid="failure">
            <code className="jevcode-failure-file">{failure.file}</code>
            <div className="jevcode-failure-test">{failure.testName}</div>
            <pre className="jevcode-failure-message">{failure.message}</pre>
          </li>
        ))}
      </ul>
      <div className="jevcode-linked-units" data-testid="linked-change-units">
        {props.linkedChangeUnits.map((unitId) => (
          <span key={unitId} className="jevcode-linked-unit" data-linked-unit={unitId}>
            {unitId}
          </span>
        ))}
      </div>
      {props.note !== undefined ? (
        <div className="jevcode-note" data-testid="failure-note">
          {props.note}
        </div>
      ) : null}
      {props.actions !== undefined && props.actions.length > 0 ? (
        <ActionButtons actions={props.actions} />
      ) : null}
    </div>
  );
}
