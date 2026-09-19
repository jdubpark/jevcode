import type { TestMatrixProps } from "@jevcode/contracts";

import { ActionButtons } from "./ActionButtons.js";

export function TestMatrix({ props }: { props: TestMatrixProps }) {
  return (
    <div className="jevcode-test-matrix" data-testid="test-matrix">
      {props.title !== undefined ? (
        <h3 className="jevcode-title">{props.title}</h3>
      ) : null}
      {props.summary !== undefined ? (
        <div className="jevcode-summary">{props.summary}</div>
      ) : null}
      <table className="jevcode-matrix">
        <thead>
          <tr>
            <th>check</th>
            <th>status</th>
            <th>passed</th>
            <th>failed</th>
            <th>skipped</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={index} data-row-name={row.name} data-status={row.status}>
              <td>{row.name}</td>
              <td>{row.status}</td>
              <td>{row.passed}</td>
              <td>{row.failed}</td>
              <td>{row.skipped}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.actions !== undefined && props.actions.length > 0 ? (
        <ActionButtons actions={props.actions} />
      ) : null}
    </div>
  );
}
