import { html as diffToHtml } from "diff2html";

import type { CodeDiffProps } from "@jevcode/contracts";

function normalizeDiff(diff: string, file: string): string {
  const lines = diff.split("\n");
  const hasFileHeader = /^--- .+/.test(lines[0] ?? "") && /^\+\+\+ .+/.test(lines[1] ?? "");
  const bodyLines = hasFileHeader ? lines.slice(2) : lines;
  const body = bodyLines.filter((line) => !/^@@ /.test(line));
  if (body.length === 0) {
    return hasFileHeader ? diff : `--- ${file}\n+++ ${file}\n`;
  }
  let oldCount = 0;
  let newCount = 0;
  for (const line of body) {
    if (line.startsWith("+")) {
      newCount += 1;
    } else if (line.startsWith("-")) {
      oldCount += 1;
    } else if (line.startsWith(" ")) {
      oldCount += 1;
      newCount += 1;
    }
  }
  const header = hasFileHeader
    ? `${lines[0]}\n${lines[1]}`
    : `--- ${file}\n+++ ${file}`;
  return `${header}\n@@ -1,${Math.max(oldCount, 1)} +1,${Math.max(newCount, 1)} @@\n${body.join("\n")}`;
}

export function CodeDiff({ props }: { props: CodeDiffProps }) {
  const normalized = normalizeDiff(props.diff, props.file);
  let rendered: string | undefined;
  try {
    rendered = diffToHtml(normalized, {
      drawFileList: false,
      outputFormat: "line-by-line",
    });
  } catch {
    rendered = undefined;
  }
  return (
    <div
      className="jevcode-code-diff"
      data-testid="code-diff"
      data-file={props.file}
    >
      {rendered !== undefined && rendered.includes("d2h-code-line") ? (
        <div dangerouslySetInnerHTML={{ __html: rendered }} />
      ) : (
        <pre>{props.diff}</pre>
      )}
    </div>
  );
}
