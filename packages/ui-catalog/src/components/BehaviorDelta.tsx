import type { BehaviorDeltaProps } from "@jevcode/contracts";

import { ActionButtons } from "./ActionButtons.js";

export function BehaviorDelta({ props }: { props: BehaviorDeltaProps }) {
  return (
    <div className="jevcode-behavior-delta" data-testid="behavior-delta">
      <div className="jevcode-badges">
        <span className="jevcode-change-badge" data-change-badge="true">
          behavior change
        </span>
        <span className="jevcode-subject-badge" data-subject={props.subject}>
          {props.subject}
        </span>
      </div>
      <h3 className="jevcode-title">{props.title}</h3>
      <div className="jevcode-before-after">
        <div className="jevcode-before-block" data-block="before">
          <div className="jevcode-block-heading">Before</div>
          <pre className="jevcode-block-text" data-testid="before">
            {props.before}
          </pre>
        </div>
        <div className="jevcode-after-block" data-block="after">
          <div className="jevcode-block-heading">After</div>
          <pre className="jevcode-block-text" data-testid="after">
            {props.after}
          </pre>
        </div>
      </div>
      <div
        className="jevcode-evidence-chip"
        data-testid="behavior-evidence"
        data-file-count={props.files.length}
        data-symbol-count={props.symbols.length}
      >
        <span className="jevcode-evidence-count">
          {props.files.length} files
        </span>
        <span className="jevcode-evidence-count">
          {props.symbols.length} symbols
        </span>
        <div className="jevcode-evidence-items">
          {props.files.map((file) => (
            <code
              key={`f-${file}`}
              className="jevcode-evidence-file"
              data-evidence-file={file}
            >
              {file}
            </code>
          ))}
          {props.symbols.map((symbol) => (
            <code
              key={`s-${symbol}`}
              className="jevcode-evidence-symbol"
              data-evidence-symbol={symbol}
            >
              {symbol}
            </code>
          ))}
        </div>
      </div>
      {props.actions !== undefined && props.actions.length > 0 ? (
        <ActionButtons actions={props.actions} />
      ) : null}
    </div>
  );
}
