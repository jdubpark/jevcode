import { displayUntrusted } from "@jevcode/trace-viewer/model";
import { useEffect, useState } from "react";

import type { RepositorySummary } from "../../shared/local-channels.js";
import { getBridge } from "../bridge.js";
import { Glyph } from "./glyph.js";

interface RecentReposProps {
  /** The open repository, tinted in the list. */
  selectedRepoId?: string | null;
  onSelect: (path: string) => void;
}

export function RecentRepos(props: RecentReposProps) {
  const bridge = getBridge();
  const [repos, setRepos] = useState<RepositorySummary[]>([]);

  useEffect(() => {
    void bridge.repo.listRecent().then(setRepos).catch((error: unknown) => {
      console.error("failed to list recent repos", error);
    });
    const off = bridge.on("repo:recentRepos", (payload) => {
      setRepos(payload.repositories);
    });
    return off;
  }, [bridge]);

  return (
    <section className="panel">
      <h2>Recent repos</h2>
      {repos.length === 0 ? (
        <p className="side-empty">None yet. Open a local repository to begin.</p>
      ) : (
        <ul className="side-list">
          {repos.map((repo) => (
            <li key={repo.repoId}>
              <button
                type="button"
                className={`side-row${repo.repoId === props.selectedRepoId ? " on" : ""}`}
                title={repo.path}
                aria-current={repo.repoId === props.selectedRepoId ? "true" : undefined}
                onClick={() => props.onSelect(repo.path)}
              >
                <Glyph name="list" />
                <span className="side-label">{displayUntrusted(repo.name)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
