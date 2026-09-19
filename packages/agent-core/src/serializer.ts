import type { StructuredDecision } from "@jevcode/contracts";

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : prefix + line))
    .join("\n");
}

export const DECLINED_LINE =
  "declined: developer declined without further instruction";

export function serializeStructuredDecision(
  input: StructuredDecision,
): string {
  const sections: string[] = [];

  const decisionEntries = Object.entries(input.decision).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (decisionEntries.length > 0) {
    sections.push(
      ["decision:", ...decisionEntries.map(([key, value]) => `  ${key}: ${value}`)].join(
        "\n",
      ),
    );
  }

  if (input.evidence.length > 0) {
    sections.push(
      ["evidence:", ...input.evidence.map((ref) => `  - ${ref}`)].join("\n"),
    );
  }

  const instruction = input.instruction;
  if (instruction !== undefined && instruction.trim().length > 0) {
    sections.push(`instruction:\n${indentBlock(instruction, 2)}`);
  } else {
    sections.push(DECLINED_LINE);
  }

  return `${sections.join("\n\n")}\n`;
}
