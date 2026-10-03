// Test-only: narrator sentences for the phase C suites. Excluded from the build.
import type { Citation, NarrativeSentence } from "@jevcode/contracts";

export function sentence(text: string, ...citations: Citation[]): NarrativeSentence {
  return { text, citations };
}
