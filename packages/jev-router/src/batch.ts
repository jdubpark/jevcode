export const MAX_ATTENTION_BATCH = 8;
export const MAX_PASS_B_IN_FLIGHT = 4;

export function chunkAttentionBatch<T>(
  items: readonly T[],
  max = MAX_ATTENTION_BATCH,
): T[][] {
  if (max <= 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += max) {
    chunks.push(items.slice(i, i + max));
  }
  return chunks;
}

export interface PassBTask {
  changeUnitId: string;
  decisionVersion: number;
}

export function selectPassBTasks(
  queue: readonly PassBTask[],
  inFlight: number,
  max = MAX_PASS_B_IN_FLIGHT,
): PassBTask[] {
  const capacity = Math.max(0, max - Math.max(0, inFlight));
  if (capacity === 0) return [];
  return queue.slice(0, capacity).map((task) => ({ ...task }));
}

export interface VersionedResult<T> {
  changeUnitId: string;
  decisionVersion: number;
  result: T;
}

export function alignResults<T>(
  inputs: ReadonlyArray<{ changeUnitId: string; decisionVersion: number }>,
  results: readonly T[],
): VersionedResult<T>[] {
  const aligned: VersionedResult<T>[] = [];
  for (let i = 0; i < inputs.length && i < results.length; i += 1) {
    const input = inputs[i];
    const result = results[i];
    if (input === undefined || result === undefined) continue;
    aligned.push({
      changeUnitId: input.changeUnitId,
      decisionVersion: input.decisionVersion,
      result,
    });
  }
  return aligned;
}

export function discardStale<T>(
  aligned: readonly VersionedResult<T>[],
  currentVersions: ReadonlyMap<string, number>,
): VersionedResult<T>[] {
  return aligned.filter((item) => {
    const current = currentVersions.get(item.changeUnitId);
    if (current === undefined) return true;
    return item.decisionVersion >= current;
  });
}
