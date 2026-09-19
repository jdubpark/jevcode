import type { JevcodeDb, RepositoryRecord, SessionRecord } from "@jevcode/storage";

import { probeGitRepo } from "./git.js";
import type { GitRepoInfo } from "./git.js";

export interface OpenedRepo {
  repo: RepositoryRecord;
  session: SessionRecord;
  info: GitRepoInfo;
}

export async function openRepoByPath(
  db: JevcodeDb,
  candidatePath: string,
): Promise<OpenedRepo> {
  const info = await probeGitRepo(candidatePath);
  const repo = db.upsertRepository({
    path: info.gitRoot,
    gitRoot: info.gitRoot,
    branch: info.branch,
    baseCommit: info.baseCommit,
  });
  const session = db.createSession({
    repoId: repo.id,
    baseCommit: info.baseCommit,
    branch: info.branch,
  });
  return { repo, session, info };
}
