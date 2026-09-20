import { useState } from "react";

import type { ChangeOverviewProps, FileDiff } from "@jevcode/contracts";

import { CodeDiff } from "./CodeDiff.js";

function CodeEvidence({
  links,
  diffs,
}: {
  links: string[];
  diffs?: FileDiff[];
}) {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const diffByFile = new Map((diffs ?? []).map((d) => [d.file, d]));
  const selectedDiff = selected !== undefined ? diffByFile.get(selected) : undefined;
  return (
    <div className="jevcode-code-evidence" data-testid="code-evidence">
      <ul>
        {links.map((link) => (
          <li key={link}>
            <button
              type="button"
              data-evidence-link={link}
              disabled={!diffByFile.has(link)}
              onClick={() => setSelected(link)}
            >
              {link}
            </button>
          </li>
        ))}
      </ul>
      {selectedDiff !== undefined ? <CodeDiff props={selectedDiff} /> : null}
    </div>
  );
}

export function ChangeOverview({ props }: { props: ChangeOverviewProps }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const hasInspectableEvidence = (props.diffs?.length ?? 0) > 0;
  return (
    <div className="jevcode-change-overview" data-testid="change-overview">
      <div className="jevcode-badges">
        <span className="jevcode-category" data-category={props.category}>
          {props.category}
        </span>
        <span className="jevcode-status" data-status={props.status}>
          {props.status}
        </span>
        {props.confidence !== undefined ? (
          <span
            className="jevcode-confidence"
            data-confidence={props.confidence}
          >
            {Math.round(props.confidence * 100)}%
          </span>
        ) : null}
        {props.scope !== undefined ? (
          <span className="jevcode-scope" data-scope={props.scope}>
            {props.scope}
          </span>
        ) : null}
      </div>
      <h3 className="jevcode-title">{props.title}</h3>
      {props.evidenceLinks !== undefined && props.evidenceLinks.length > 0 ? (
        <div className="jevcode-evidence">
          {hasInspectableEvidence ? (
            <button
              type="button"
              data-testid="evidence-toggle"
              onClick={() => setEvidenceOpen((open) => !open)}
            >
              Inspect evidence ({props.evidenceLinks.length})
            </button>
          ) : (
            <span className="jevcode-evidence-summary">
              Grounded in {props.evidenceLinks.length} evidence items
            </span>
          )}
          {hasInspectableEvidence && evidenceOpen ? (
            <CodeEvidence links={props.evidenceLinks} diffs={props.diffs} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
