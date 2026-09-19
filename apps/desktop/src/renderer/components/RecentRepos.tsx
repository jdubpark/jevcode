import { useEffect, useState } from "react";

import type { RepositorySummary } from "../../shared/local-channels.js";
import { getBridge } from "../bridge.js";

interface RecentReposProps {
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
      <h2>Recent repositories</h2>
      {repos.length === 0 ? (
        <p className="dim">None yet. Open a local repository to begin.</p>
      ) : (
        <ul className="repo-list">
          {repos.map((repo) => (
            <li key={repo.repoId}>
              <button type="button" onClick={() => props.onSelect(repo.path)}>
                <span className="repo-list-name">{repo.name}</span>
                <span className="repo-list-path dim">{repo.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
