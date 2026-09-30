import type { EvidenceFact, GitHunkDiff } from "@jevcode/contracts";
import { diffBytes, diffHash } from "@jevcode/evidence-engine";

export interface RedactionResult {
  text: string;
  count: number;
}

interface RedactionRule {
  kind: string;
  pattern: RegExp;
  replacement: string;
}

// Already-redacted guard (spec §4.3 rule 4): placed before a rule's value part,
// so a value an earlier rule replaced is not counted again and a second pass
// over redacted text is a no-op. The optional quote covers value classes that
// admit one: `api_key: "sk-proj-…"` is caught by provider_key, and token then
// sees `"[REDACTED:provider_key]"`.
const UNREDACTED = String.raw`(?!["'\x60]?\[REDACTED:)`;

// Order matters only for the label: specific token shapes run before the
// generic key=value rules, which then skip the value through the guard.
const RULES: readonly RedactionRule[] = [
  {
    kind: "aws_key",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws_key]",
  },
  {
    kind: "jwt",
    pattern: /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private_key]",
  },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    replacement: "[REDACTED:github_token]",
  },
  {
    kind: "slack_token",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replacement: "[REDACTED:slack_token]",
  },
  {
    kind: "provider_key",
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35})\b/g,
    replacement: "[REDACTED:provider_key]",
  },
  {
    kind: "bearer",
    pattern: new RegExp(String.raw`\b(Bearer)\s+${UNREDACTED}[A-Za-z0-9._~+\/=-]{16,}`, "g"),
    replacement: "$1 [REDACTED:bearer]",
  },
  {
    kind: "url_credential",
    pattern: new RegExp(
      String.raw`\b([a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)${UNREDACTED}[^\s@\/]+@`,
      "gi",
    ),
    replacement: "$1[REDACTED:url_password]@",
  },
  {
    kind: "aws_secret",
    pattern: new RegExp(
      String.raw`\b(aws_secret_access_key)\s*[:=]\s*${UNREDACTED}[A-Za-z0-9\/+=]{40}`,
      "gi",
    ),
    replacement: "$1=[REDACTED:aws_secret]",
  },
  {
    kind: "password",
    pattern: new RegExp(String.raw`\b(password|passwd|pwd)\b\s*=\s*${UNREDACTED}[^\s;,)]+`, "gi"),
    replacement: "$1=[REDACTED:password]",
  },
  {
    kind: "token",
    pattern: new RegExp(
      String.raw`\b(token|access_token|refresh_token|api[_-]?key|apikey|secret)\b\s*[:=]\s*${UNREDACTED}[^\s;,)]+`,
      "gi",
    ),
    replacement: "$1=[REDACTED:token]",
  },
  {
    kind: "env_value",
    // KEY=value at a line start, after optional leading whitespace and
    // `export `. One optional unified-diff prefix ("+", "-" or " ") is also
    // accepted, so a whole diff passed here is still caught; the prefix,
    // indentation and `export ` are kept. The value stays on its own line.
    pattern: new RegExp(
      String.raw`^([+\- ]?[ \t]*(?:export[ \t]+)?)([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)[ \t]*=[ \t]*${UNREDACTED}\S.*$`,
      "gm",
    ),
    replacement: "$1$2=[REDACTED:env_value]",
  },
];

export function redactText(input: string): RedactionResult {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    let matched = 0;
    text = text.replace(rule.pattern, (...args) => {
      matched += 1;
      const captures = args.slice(1, args.length - 2) as string[];
      return rule.replacement.replace(
        /\$(\d)/g,
        (_sub, index) => captures[Number(index) - 1] ?? "",
      );
    });
    count += matched;
  }
  return { text, count };
}

export function redactEvidenceFact(
  fact: EvidenceFact,
): { fact: EvidenceFact; count: number } {
  let count = 0;
  const redact = (value: string): string => {
    const result = redactText(value);
    count += result.count;
    return result.text;
  };
  switch (fact.type) {
    case "git_hunk":
      return { fact, count };
    case "file_changed":
      return { fact, count };
    case "symbol_delta":
      return { fact, count };
    case "dependency_change":
      return {
        fact: {
          ...fact,
          manifest: redact(fact.manifest),
          added: fact.added.map((entry) => ({ ...entry, name: redact(entry.name) })),
          removed: fact.removed.map((entry) => ({ ...entry, name: redact(entry.name) })),
        },
        count,
      };
    case "test_result":
      return {
        fact: {
          ...fact,
          command: redact(fact.command),
          failures: fact.failures.map((failure) => ({
            ...failure,
            message: redact(failure.message),
          })),
        },
        count,
      };
    case "command_executed":
      return {
        fact: { ...fact, command: redact(fact.command) },
        count,
      };
    case "revert_detected":
      return { fact, count };
  }
}

/** Stored diff text is capped at 32 KiB (UTF-8 bytes) (R3). */
export const DIFF_TEXT_CAP_BYTES = 32 * 1024;

// Basenames whose diff is never stored (spec §4.3 rule 3): R3's .env*, *.pem,
// *.key and id_rsa*, plus the other SSH private keys (their .pub halves stay
// visible), keystores and credential files.
const SECRET_BASENAMES: readonly RegExp[] = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_(?:ed25519|ecdsa|dsa)(?!.*\.pub$)/i,
  /\.(?:p12|pfx|jks|keystore)$/i,
  /^\.(?:npmrc|netrc|pgpass|pypirc)$/i,
  /^credentials$/i,
];

/**
 * True for files whose diff is never stored: .env*, *.pem, *.key, id_rsa*,
 * id_ed25519*, id_ecdsa* and id_dsa* except *.pub, *.p12, *.pfx, *.jks,
 * *.keystore, .npmrc, .netrc, .pgpass, .pypirc and credentials (such as
 * ~/.aws/credentials).
 */
export function isSecretPath(file: string): boolean {
  const basename = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return SECRET_BASENAMES.some((pattern) => pattern.test(basename));
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
// "@@ -a[,b] +c[,d] @@"; git may append a heading (the enclosing function line).
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
// Lines of a file's header block (after "diff --git", before its first "@@").
const FILE_HEADER_LINE =
  /^(?:index |--- |\+\+\+ |(?:new|deleted) file mode |old mode |new mode |(?:dis)?similarity index |rename (?:from|to) |copy (?:from|to) |Binary files )/;

interface RedactedDiff {
  text: string;
  /** Output offset of the end of the line behind each redaction, in order. */
  redactionEnds: number[];
}

/**
 * Redacts a single-file unified diff line by line (spec §4.3 rule 3).
 *
 * Lines are classified first. `---`/`+++` are headers only in a file's header
 * block (after `diff --git`, before its first `@@`); inside a hunk every line
 * is classified by its first character and counted against the `@@` header's
 * old and new line counts, so a removed `-- password=…` line is content.
 * Header-block lines, the `@@ … @@` part of hunk headers, `Binary files …
 * differ` and `\ No newline at end of file` are kept verbatim. The heading git
 * appends after `@@ … @@` is a line of the file, so it is redacted.
 *
 * Each PEM private-key block becomes the single line "[REDACTED:private_key]"
 * behind its BEGIN line's diff prefix before any other rule runs, counting one
 * redaction. A block runs through the next line containing "-----END …
 * PRIVATE KEY-----", or to the end of its hunk (the next `@@` or `diff --git`
 * line). Certificates and public keys are kept. Every other hunk line is
 * redacted after its one-character prefix. A line that is neither structure
 * nor a counted hunk line is redacted whole.
 *
 * Stops once the output passes `stopAfterBytes` UTF-8 bytes, because the cap
 * keeps no more; a 2 MiB lockfile diff costs about as much as a 32 KiB one.
 */
function redactDiffLines(diff: string, stopAfterBytes: number): RedactedDiff {
  const out: string[] = [];
  const redactionEnds: number[] = [];
  let outLength = 0;
  let outBytes = 0;
  // header: before the first "@@" of a file; hunk: inside a hunk body while
  // its line counts last; after: past a hunk body.
  let state: "header" | "hunk" | "after" = "header";
  let oldLeft = 0;
  let newLeft = 0;
  let pos = 0;

  const readLine = (): { line: string; eol: string } => {
    const newline = diff.indexOf("\n", pos);
    const end = newline === -1 ? diff.length : newline;
    const line = diff.slice(pos, end);
    pos = newline === -1 ? diff.length : newline + 1;
    return { line, eol: newline === -1 ? "" : "\n" };
  };
  const countHunkLine = (prefix: string): void => {
    if (state !== "hunk") return;
    if (prefix !== "+") oldLeft -= 1;
    if (prefix !== "-") newLeft -= 1;
    if (oldLeft <= 0 && newLeft <= 0) state = "after";
  };
  const push = (text: string, redactions: number): void => {
    out.push(text);
    outLength += text.length;
    outBytes += Buffer.byteLength(text, "utf8");
    for (let index = 0; index < redactions; index += 1) redactionEnds.push(outLength);
  };
  // Replaces the key block whose BEGIN is in `rest` (the line after `prefix`).
  const collapseKeyBlock = (prefix: string, rest: string, eol: string): void => {
    let blockEol = eol;
    const begin = PRIVATE_KEY_BEGIN.exec(rest);
    if (begin !== null && !PRIVATE_KEY_END.test(rest.slice(begin.index))) {
      while (
        pos < diff.length &&
        !diff.startsWith("@@", pos) &&
        !diff.startsWith("diff --git ", pos)
      ) {
        const inner = readLine();
        if (/^[+\- ]/.test(inner.line)) countHunkLine(inner.line.charAt(0));
        blockEol = inner.eol;
        if (PRIVATE_KEY_END.test(inner.line)) break;
      }
    }
    push(`${prefix}[REDACTED:private_key]${blockEol}`, 1);
  };

  while (pos < diff.length && outBytes <= stopAfterBytes) {
    const { line, eol } = readLine();
    const first = line.charAt(0);
    if (state === "hunk") {
      if (first === "\\") {
        push(line + eol, 0);
        continue;
      }
      if (first === "+" || first === "-" || first === " ") {
        countHunkLine(first);
        const content = line.slice(1);
        if (PRIVATE_KEY_BEGIN.test(content)) {
          collapseKeyBlock(first, content, eol);
          continue;
        }
        const redacted = redactText(content);
        push(first + redacted.text + eol, redacted.count);
        continue;
      }
      // The hunk's counts ran out early: classify the line as structure.
      state = "after";
    }
    if (line.startsWith("diff --git ")) {
      state = "header";
      push(line + eol, 0);
      continue;
    }
    const hunk = first === "@" ? HUNK_HEADER.exec(line) : null;
    if (hunk !== null) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      state = oldLeft > 0 || newLeft > 0 ? "hunk" : "after";
      const heading = redactText(line.slice(hunk[0].length));
      push(hunk[0] + heading.text + eol, heading.count);
      continue;
    }
    if (first === "\\" || (state === "header" && FILE_HEADER_LINE.test(line))) {
      push(line + eol, 0);
      continue;
    }
    // Not unified-diff structure: redact the whole line.
    const begin = PRIVATE_KEY_BEGIN.exec(line);
    if (begin !== null) {
      const prefix = begin.index > 0 && /^[+\- ]/.test(line) ? first : "";
      collapseKeyBlock(prefix, line.slice(prefix.length), eol);
      continue;
    }
    const redacted = redactText(line);
    push(redacted.text + eol, redacted.count);
  }
  return { text: out.join(""), redactionEnds };
}

/**
 * Caps a single-file unified diff at `capBytes` UTF-8 bytes. Keeps every
 * complete hunk that fits and cuts before the "@@" header of the first hunk
 * that would overflow. When even the first hunk overflows, keeps the file
 * header and that hunk up to the last whole line within the cap. Walks only
 * the lines it keeps, so a 2 MiB lockfile diff costs no more than 32 KiB.
 */
export function capDiffText(
  diff: string,
  capBytes: number = DIFF_TEXT_CAP_BYTES,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(diff, "utf8") <= capBytes) {
    return { text: diff, truncated: false };
  }
  let keptEnd = 0;
  let keptBytes = 0;
  let hunkStart = 0;
  let hunks = 0;
  while (keptEnd < diff.length) {
    const newline = diff.indexOf("\n", keptEnd);
    const lineEnd = newline === -1 ? diff.length : newline + 1;
    if (diff.startsWith("@@", keptEnd)) {
      hunkStart = keptEnd;
      hunks += 1;
    }
    const size = Buffer.byteLength(diff.slice(keptEnd, lineEnd), "utf8");
    if (keptBytes + size > capBytes) {
      return { text: diff.slice(0, hunks >= 2 ? hunkStart : keptEnd), truncated: true };
    }
    keptEnd = lineEnd;
    keptBytes += size;
  }
  return { text: diff, truncated: false };
}

/**
 * The desktop PrepareDiff (injected into the git collector): withholds secret
 * paths, then redacts line by line (private-key blocks first), then caps the
 * text (spec §4.3 rule 3). `hash` and `bytes` describe the raw diff;
 * `redactions` counts the replacements in the stored text, one per key block.
 */
export function prepareDiffForStorage(file: string, rawDiff: string): GitHunkDiff {
  const hash = diffHash(rawDiff);
  const bytes = diffBytes(rawDiff);
  if (isSecretPath(file)) {
    return { hash, bytes, truncated: false, redactions: 0, withheld: "secret_path" };
  }
  const redacted = redactDiffLines(rawDiff, DIFF_TEXT_CAP_BYTES);
  const capped = capDiffText(redacted.text);
  const kept = capped.text.length;
  return {
    hash,
    bytes,
    text: capped.text,
    truncated: capped.truncated,
    redactions: redacted.redactionEnds.filter((end) => end <= kept).length,
  };
}
