import { describe, expect, it } from "vitest";

import { SAMPLE_BRIEFS, universeFor } from "../testing/narrator-recorded.js";
import { createAnthropicNarratorTransport } from "./anthropic-transport.js";
import { createNarratorClient } from "./client.js";
import { guardComponents } from "./guardrails.js";
import type { ComponentBrief } from "./types.js";
import { NARRATOR_TIMEOUT_MS } from "./types.js";

const KEY = process.env["ANTHROPIC_API_KEY"] ?? "";
const LIVE = process.env["JEVCODE_NARRATOR_LIVE"] === "1" && KEY.trim() !== "";

// Opt-in: JEVCODE_NARRATOR_LIVE=1 ANTHROPIC_API_KEY=… pnpm --filter @jevcode/jev-router exec vitest run src/narrator/narrator.live.test.ts
describe.skipIf(!LIVE)("narrator against the real API (opt-in, spec §11 budget probe)", () => {
  it("describes a full batch of 20 inside the 10 s timeout with schema-valid, guard-passing output", async () => {
    const batch: ComponentBrief[] = Array.from({ length: 20 }, (_, index) => {
      const base = SAMPLE_BRIEFS[index % SAMPLE_BRIEFS.length]!;
      return { ...base, id: `cmp_${(index + 1).toString(16).padStart(12, "0")}`, name: `component-${index}` };
    });
    const client = createNarratorClient(createAnthropicNarratorTransport({ apiKey: KEY }));
    const result = await client.describeComponents(batch);
    console.log(
      `NARRATOR_LIVE describe ms=${result.ms} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`,
    );
    expect(result.schemaValid).toBe(true);
    expect(result.ms).toBeLessThan(NARRATOR_TIMEOUT_MS);
    expect(guardComponents(result.value, universeFor(batch), batch.map((brief) => brief.id)).discarded).toBe(false);
  }, 15_000);
});
