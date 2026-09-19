import type { EvidenceFact } from "@jevcode/contracts";

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
    pattern: /^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*.+$/gm,
    replacement: "$1=[REDACTED:env_value]",
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
