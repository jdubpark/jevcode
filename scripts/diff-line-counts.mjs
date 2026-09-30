// Counts "+" and "-" lines after the first "@@" header, so "---"/"+++" file
// headers are never counted. Shared by scripts/validate-fixtures.mjs, which
// checks a git_hunk's added/removed against this count, and
// scripts/fixture-diffs.mjs, which computes added/removed with it.
export function diffLineCounts(text) {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}
