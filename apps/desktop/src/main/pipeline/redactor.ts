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
    kind: "password",
    pattern: /\b(password|passwd|pwd)\b\s*=\s*[^\s;,)]+/gi,
    replacement: "$1=[REDACTED:password]",
  },
  {
    kind: "token",
    pattern: /\b(token|access_token|refresh_token|api[_-]?key|apikey|secret)\b\s*[:=]\s*[^\s;,)]+/gi,
    replacement: "$1=[REDACTED:token]",
  },
  {
    kind: "env_value",
    // One optional unified-diff prefix ("+", "-" or " ") so KEY=value lines
    // inside a stored diff are caught too; the prefix is kept.
    pattern: /^([+\- ]?)([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*.+$/gm,
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

// Basenames whose diff is never stored. R3's .env*, *.pem, *.key and id_rsa*,
// plus the other SSH private keys (their .pub halves stay visible), keystores
// and credential dotfiles (spec §16 "Plan follow-ups", A1-7).
const SECRET_BASENAMES: readonly RegExp[] = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_(?:ed25519|ecdsa|dsa)(?!.*\.pub$)/i,
  /\.(?:p12|pfx|jks|keystore)$/i,
  /^\.(?:npmrc|netrc|pgpass)$/i,
];

/**
 * True for files whose diff is never stored: .env*, *.pem, *.key, id_rsa*,
 * id_ed25519*, id_ecdsa* and id_dsa* except *.pub, *.p12, *.pfx, *.jks,
 * *.keystore, .npmrc, .netrc and .pgpass.
 */
export function isSecretPath(file: string): boolean {
  const basename = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return SECRET_BASENAMES.some((pattern) => pattern.test(basename));
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const HUNK_BOUNDARY = /^(?:@@|diff --git )/;

/**
 * Replaces each PEM private-key block in a unified diff with the single line
 * "[REDACTED:private_key]", keeping the diff prefix ("+", "-" or " ") of the
 * block's BEGIN line, and counts one redaction per block. A block runs from a
 * line containing "-----BEGIN … PRIVATE KEY-----" through the next line
 * containing "-----END … PRIVATE KEY-----"; without one it runs to the end of
 * its hunk. Public blocks ("-----BEGIN CERTIFICATE-----", "PUBLIC KEY") stay.
 */
function redactPrivateKeyBlocks(diff: string): RedactionResult {
  if (!diff.includes("PRIVATE KEY-----")) return { text: diff, count: 0 };
  const lines = diff.split("\n");
  // A diff ending in "\n" splits into a final "" that belongs to no block.
  const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const out: string[] = [];
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const begin = index < end ? PRIVATE_KEY_BEGIN.exec(line) : null;
    if (begin === null) {
      out.push(line);
      continue;
    }
    const prefix = begin.index > 0 && /^[+\- ]/.test(line) ? line.charAt(0) : "";
    out.push(`${prefix}[REDACTED:private_key]`);
    count += 1;
    if (PRIVATE_KEY_END.test(line.slice(begin.index))) continue;
    while (index + 1 < end && !HUNK_BOUNDARY.test(lines[index + 1] ?? "")) {
      index += 1;
      if (PRIVATE_KEY_END.test(lines[index] ?? "")) break;
    }
  }
  return { text: out.join("\n"), count };
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
 * paths, replaces private-key blocks, redacts every line after its diff prefix,
 * then caps the text. `hash` and `bytes` describe the raw diff; `redactions`
 * counts every replacement made before the cap (one per key block).
 */
export function prepareDiffForStorage(file: string, rawDiff: string): GitHunkDiff {
  const hash = diffHash(rawDiff);
  const bytes = diffBytes(rawDiff);
  if (isSecretPath(file)) {
    return { hash, bytes, truncated: false, redactions: 0, withheld: "secret_path" };
  }
  const keys = redactPrivateKeyBlocks(rawDiff);
  const redacted = redactText(keys.text);
  const capped = capDiffText(redacted.text);
  return {
    hash,
    bytes,
    text: capped.text,
    truncated: capped.truncated,
    redactions: keys.count + redacted.count,
  };
}
