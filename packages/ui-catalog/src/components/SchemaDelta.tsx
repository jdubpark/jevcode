import type { SchemaChange, SchemaDeltaProps } from "@jevcode/contracts";

import { ActionButtons } from "./ActionButtons.js";

export interface SchemaChangeSummary {
  added: number;
  removed: number;
  modified: number;
  groups: {
    entity: string;
    entityType: SchemaChange["entityType"];
    changes: SchemaChange[];
  }[];
}

export function summarizeSchemaChanges(
  changes: readonly SchemaChange[],
): SchemaChangeSummary {
  const groups = new Map<
    string,
    { entity: string; entityType: SchemaChange["entityType"]; changes: SchemaChange[] }
  >();
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const change of changes) {
    if (change.change === "added") {
      added += 1;
    } else if (change.change === "removed") {
      removed += 1;
    } else {
      modified += 1;
    }
    const key = `${change.entityType}:${change.entity}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        entity: change.entity,
        entityType: change.entityType,
        changes: [],
      };
      groups.set(key, group);
    }
    group.changes.push(change);
  }
  return { added, removed, modified, groups: [...groups.values()] };
}

export function SchemaDelta({ props }: { props: SchemaDeltaProps }) {
  const summary = summarizeSchemaChanges(props.changes);
  return (
    <div className="jevcode-schema-delta" data-testid="schema-delta">
      <h3 className="jevcode-title">{props.title}</h3>
      <code className="jevcode-migration">{props.migration}</code>
      <div className="jevcode-schema-counts" data-testid="schema-counts">
        <span className="jevcode-count" data-change="added" data-count={summary.added}>
          {summary.added} added
        </span>
        <span
          className="jevcode-count"
          data-change="removed"
          data-count={summary.removed}
        >
          {summary.removed} removed
        </span>
        <span
          className="jevcode-count"
          data-change="modified"
          data-count={summary.modified}
        >
          {summary.modified} modified
        </span>
      </div>
      <table className="jevcode-schema-table" data-testid="schema-table">
        <thead>
          <tr>
            <th>entity</th>
            <th>type</th>
            <th>change</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody>
          {summary.groups.map((group) => (
            <tr
              key={`${group.entityType}:${group.entity}`}
              className="jevcode-schema-entity"
              data-entity={group.entity}
              data-entity-type={group.entityType}
            >
              <td>{group.entity}</td>
              <td>{group.entityType}</td>
              <td>
                {group.changes.map((change) => (
                  <span
                    key={`${group.entity}-${change.change}`}
                    className="jevcode-schema-change"
                    data-change={change.change}
                  >
                    {change.change}
                  </span>
                ))}
              </td>
              <td>
                {group.changes.map((change) =>
                  change.before !== undefined || change.after !== undefined ? (
                    <div
                      key={`${group.entity}-${change.change}-detail`}
                      className="jevcode-schema-detail"
                      data-testid="schema-detail"
                    >
                      <code>{change.before ?? "(none)"}</code>
                      <span> → </span>
                      <code>{change.after ?? "(none)"}</code>
                    </div>
                  ) : null,
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.compatibilityNote !== undefined ? (
        <div
          className="jevcode-compatibility-note"
          data-testid="compatibility-note"
        >
          {props.compatibilityNote}
        </div>
      ) : null}
      {props.actions !== undefined && props.actions.length > 0 ? (
        <ActionButtons actions={props.actions} />
      ) : null}
    </div>
  );
}
