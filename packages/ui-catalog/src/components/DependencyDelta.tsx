import type { DependencyDeltaItem, DependencyDeltaProps } from "@jevcode/contracts";

import { ActionButtons } from "./ActionButtons.js";

export const DEPENDENCY_CHILDREN_CONTAINER_ID = "jevcode-dependency-children";

function DependencyList({
  kind,
  deps,
}: {
  kind: "added" | "removed";
  deps: DependencyDeltaItem[];
}) {
  return (
    <div
      className={
        kind === "added" ? "jevcode-deps-added" : "jevcode-deps-removed"
      }
      data-testid={`deps-${kind}`}
    >
      <div className="jevcode-dep-section-heading">
        {kind === "added" ? "Added" : "Removed"}
      </div>
      <ul>
        {deps.map((dep) => (
          <li
            key={dep.name}
            className="jevcode-dep"
            data-dep={dep.name}
            data-dep-kind={kind}
          >
            <code className="jevcode-dep-name">
              {kind === "added" ? "+ " : "- "}
              {dep.name}
              {dep.version !== undefined ? ` ${dep.version}` : ""}
            </code>
            {dep.reason !== undefined ? (
              <div className="jevcode-dep-reason" data-testid="dep-reason">
                {dep.reason}
              </div>
            ) : null}
            {dep.usage !== undefined ? (
              <div className="jevcode-dep-usage" data-testid="dep-usage">
                <code>{dep.usage}</code>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DependencyDelta({
  props,
  diffChildPresent = false,
}: {
  props: DependencyDeltaProps;
  diffChildPresent?: boolean;
}) {
  const scrollToDiff = () => {
    const container = document.getElementById(
      DEPENDENCY_CHILDREN_CONTAINER_ID,
    );
    container?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  };
  return (
    <div className="jevcode-dependency-delta" data-testid="dependency-delta">
      <h3 className="jevcode-title">{props.title}</h3>
      <div className="jevcode-dep-badges">
        <span
          className="jevcode-dep-count"
          data-added-count={props.added.length}
        >
          {props.added.length} added
        </span>
        <span
          className="jevcode-dep-count"
          data-removed-count={props.removed.length}
        >
          {props.removed.length} removed
        </span>
      </div>
      {props.added.length > 0 ? (
        <DependencyList kind="added" deps={props.added} />
      ) : null}
      {props.removed.length > 0 ? (
        <DependencyList kind="removed" deps={props.removed} />
      ) : null}
      {diffChildPresent ? (
        <button
          type="button"
          className="jevcode-dep-diff-link"
          data-testid="dep-diff-link"
          onClick={scrollToDiff}
        >
          View exact diff
        </button>
      ) : null}
      {props.actions !== undefined && props.actions.length > 0 ? (
        <ActionButtons actions={props.actions} />
      ) : null}
    </div>
  );
}
