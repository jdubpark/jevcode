import type { RepositoryRecord, SessionRecord } from "@jevcode/storage";

import type { GitRepoInfo } from "./git.js";

export interface AppState {
  repo: RepositoryRecord | null;
  info: GitRepoInfo | null;
  session: SessionRecord | null;
}

export function createAppState(): AppState {
  return { repo: null, info: null, session: null };
}
