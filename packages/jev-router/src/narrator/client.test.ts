import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_ID,
  SAMPLE_BRIEFS,
  STORAGE_ID,
  VIEWER_ID,
  universeFor,
} from "../testing/narrator-recorded.js";
import { createFakeNarratorClient, createNarratorClient, FAKE_SCHEMA_INVALID } from "./client.js";
import { NarratorUnavailableError } from "./errors.js";
import { guardComponents } from "./guardrails.js";
import {
  BRIEF_LIMITS,
  DESCRIBE_MAX_TOKENS,
  DESCRIBE_OUTPUT_JSON_SCHEMA,
  DESCRIBE_SYSTEM_PROMPT,
  OVERVIEW_MAX_TOKENS,
  OVERVIEW_SYSTEM_PROMPT,
  SENTENCES_OUTPUT_JSON_SCHEMA,
} from "./prompts.js";
import type { ComponentBrief, NarratorTransport, NarratorTransportRequest, NarratorTransportResponse } from "./types.js";
import { NARRATOR_MODEL, NARRATOR_TIMEOUT_MS } from "./types.js";

function capturing(respond: (request: NarratorTransportRequest) => NarratorTransportResponse | Promise<NarratorTransportResponse>) {
  const requests: NarratorTransportRequest[] = [];
  const transport: NarratorTransport = {
    async complete(request) {
      requests.push(request);
      return respond(request);
    },
  };
  return { transport, requests };
}

const answer = (json: unknown): NarratorTransportResponse => ({
  json,
  model: NARRATOR_MODEL,
  stopReason: "end_turn",
  usage: { inputTokens: 1200, outputTokens: 300 },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("describeComponents request", () => {
  it("sends keyed metadata only, with the fixed model, timeout, schema and system prompt", async () => {
    const { transport, requests } = capturing(() => answer({ components: [] }));
    await createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({
      model: NARRATOR_MODEL,
      timeoutMs: NARRATOR_TIMEOUT_MS,
      maxTokens: DESCRIBE_MAX_TOKENS,
      system: DESCRIBE_SYSTEM_PROMPT,
      schema: DESCRIBE_OUTPUT_JSON_SCHEMA,
    });
    const state = JSON.parse(request.user) as { task: string; components: Record<string, unknown>[] };
    expect(state.task).toBe("describe_components");
    expect(state.components.map((entry) => entry["key"])).toEqual(["c1", "c2", "c3"]);
    for (const entry of state.components) {
      expect(Object.keys(entry).sort()).toEqual([
        "blurb", "exports", "externalDeps", "files", "importedBy", "imports", "key", "name", "path", "roleGuess",
      ]);
    }
    expect(state.components[0]!["files"]).toEqual([
      { key: "c1.f1", path: "apps/desktop/src/main/index.ts" },
      { key: "c1.f2", path: "apps/desktop/src/main/ipc.ts" },
      { key: "c1.f3", path: "apps/desktop/src/renderer/App.tsx" },
    ]);
    expect(request.user).not.toContain(DESKTOP_ID);
  });

  it("clips every field to the spec §6.2 caps", async () => {
    const big: ComponentBrief = {
      ...SAMPLE_BRIEFS[1]!,
      name: "n".repeat(500),
      files: Array.from({ length: 50 }, (_, index) => `packages/storage/src/f${index}.ts`),
      exports: Array.from({ length: 40 }, (_, index) => `symbol${index}`),
      externalDeps: Array.from({ length: 12 }, (_, index) => `dep-${index}`),
      edgesIn: Array.from({ length: 30 }, (_, index) => ({ name: `in-${index}`, count: index + 1 })),
      edgesOut: Array.from({ length: 30 }, (_, index) => ({ name: `out-${index}`, count: index + 1 })),
      blurb: "word ".repeat(400),
    };
    const { transport, requests } = capturing(() => answer({ components: [] }));
    await createNarratorClient(transport).describeComponents([big]);
    const entry = (JSON.parse(requests[0]!.user) as { components: Record<string, unknown[] | string>[] }).components[0]!;
    expect(entry["files"]).toHaveLength(BRIEF_LIMITS.files);
    expect(entry["exports"]).toHaveLength(BRIEF_LIMITS.exports);
    expect(entry["externalDeps"]).toHaveLength(BRIEF_LIMITS.externalDeps);
    expect(entry["importedBy"]).toHaveLength(BRIEF_LIMITS.edges);
    expect(entry["imports"]).toHaveLength(BRIEF_LIMITS.edges);
    expect(Array.from(entry["blurb"] as string)).toHaveLength(BRIEF_LIMITS.blurbChars);
    expect(Array.from(entry["name"] as string)).toHaveLength(BRIEF_LIMITS.nameChars);
  });

  it("rejects batches over 20 and skips the call for an empty batch", async () => {
    const { transport, requests } = capturing(() => answer({ components: [] }));
    const client = createNarratorClient(transport);
    const batch = Array.from({ length: 21 }, (_, index) => ({ ...SAMPLE_BRIEFS[0]!, id: `cmp_${(index + 1).toString(16).padStart(12, "0")}` }));
    await expect(client.describeComponents(batch)).rejects.toThrow(RangeError);
    await expect(client.describeComponents([])).resolves.toMatchObject({ value: [], schemaValid: true, usage: null });
    expect(requests).toEqual([]);
  });
});

describe("describeComponents answers", () => {
  it("maps keys back to component ids and file paths", async () => {
    const { transport } = capturing(() =>
      answer({
        components: [
          { key: "c1", purpose: "Electron app that runs the pipeline.", role: "api", cite: ["c1", "c1.f2"] },
          { key: "c2", purpose: "SQLite event store.", role: "storage", cite: ["c2.f1"] },
        ],
      }),
    );
    const result = await createNarratorClient(transport, { now: () => 0 }).describeComponents(SAMPLE_BRIEFS);
    expect(result).toMatchObject({ schemaValid: true, model: NARRATOR_MODEL, usage: { inputTokens: 1200, outputTokens: 300 }, confidence: 1 });
    expect(result.value).toEqual([
      { id: DESKTOP_ID, purpose: "Electron app that runs the pipeline.", role: "api", citations: [{ kind: "component", id: DESKTOP_ID }, { kind: "file", id: "apps/desktop/src/main/ipc.ts" }] },
      { id: STORAGE_ID, purpose: "SQLite event store.", role: "storage", citations: [{ kind: "file", id: "packages/storage/src/db.ts" }] },
    ]);
  });

  it("maps invented keys to unresolvable citations that the guard drops (Review Focus 2)", async () => {
    const { transport } = capturing(() =>
      answer({
        components: [
          { key: "c9", purpose: "Owns everything.", role: "domain", cite: ["c9"] },
          { key: "c1", purpose: "Electron app.", role: "api", cite: ["c1.f99"] },
          { key: "c3", purpose: "React viewer that draws the views.", role: "ui", cite: ["c3"] },
        ],
      }),
    );
    const result = await createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS);
    expect(result.value.map((entry) => entry.id)).toEqual(["unknown:c9", DESKTOP_ID, VIEWER_ID]);
    expect(result.value[1]!.citations).toEqual([{ kind: "component", id: "unresolved:c1.f99" }]);
    const guarded = guardComponents(result.value, universeFor(SAMPLE_BRIEFS), SAMPLE_BRIEFS.map((brief) => brief.id));
    expect(guarded.discarded).toBe(true);
    expect(guarded.reasons).toEqual(["0:unknown_id", "1:unresolved_citation", "batch_discarded"]);
  });

  it.each([
    ["a role outside the list", { components: [{ key: "c1", purpose: "x", role: "admin", cite: ["c1"] }] }],
    ["a missing field", { components: [{ key: "c1", purpose: "x", cite: ["c1"] }] }],
    ["the wrong top-level shape", [{ key: "c1" }]],
    ["no JSON at all", undefined],
  ])("drops an answer with %s (schemaValid false, empty value)", async (_label, json) => {
    const { transport } = capturing(() => ({ json, model: NARRATOR_MODEL, stopReason: "end_turn", usage: null }));
    const result = await createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS);
    expect(result).toMatchObject({ value: [], schemaValid: false, confidence: 0 });
  });
});

describe("overviewNarrative", () => {
  it("sends components and the top 40 edges by count, and maps cited keys back", async () => {
    const { transport, requests } = capturing(() =>
      answer({ sentences: [{ text: "The desktop app writes to storage.", cite: ["c1", "c2", "c7"] }] }),
    );
    const components = SAMPLE_BRIEFS.map((brief) => ({ id: brief.id, name: brief.name, role: brief.roleGuess, purpose: null }));
    const edges = [
      ...Array.from({ length: 45 }, (_, index) => ({ from: DESKTOP_ID, to: STORAGE_ID, count: index + 1 })),
      { from: DESKTOP_ID, to: "cmp_ffffffffffff", count: 999 },
    ];
    const result = await createNarratorClient(transport).overviewNarrative({ components, edges });
    const request = requests[0]!;
    expect(request).toMatchObject({ system: OVERVIEW_SYSTEM_PROMPT, schema: SENTENCES_OUTPUT_JSON_SCHEMA, maxTokens: OVERVIEW_MAX_TOKENS });
    const state = JSON.parse(request.user) as { edges: { from: string; to: string; count: number }[] };
    expect(state.edges).toHaveLength(40);
    expect(state.edges[0]).toEqual({ from: "c1", to: "c2", count: 45 });
    expect(result.value).toEqual([
      {
        text: "The desktop app writes to storage.",
        citations: [
          { kind: "component", id: DESKTOP_ID },
          { kind: "component", id: STORAGE_ID },
          { kind: "component", id: "unresolved:c7" },
        ],
      },
    ]);
  });
});

describe("failures", () => {
  it("rejects with reason timeout after 10 s and aborts the transport", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const transport: NarratorTransport = {
      complete: (request) => {
        seen = request.signal;
        return new Promise(() => undefined);
      },
    };
    const pending = createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS);
    const assertion = expect(pending).rejects.toMatchObject({ name: "NarratorUnavailableError", reason: "timeout" });
    await vi.advanceTimersByTimeAsync(NARRATOR_TIMEOUT_MS - 1);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("rejects with reason aborted when the caller aborts", async () => {
    const controller = new AbortController();
    const transport: NarratorTransport = { complete: () => new Promise(() => undefined) };
    const pending = createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
    await expect(
      createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS, { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
  });

  it("keeps the timeout reason when the transport rejects synchronously on abort", async () => {
    vi.useFakeTimers();
    const transport: NarratorTransport = {
      complete: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new NarratorUnavailableError("offline", "abort listener")));
        }),
    };
    const pending = createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS);
    const assertion = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(NARRATOR_TIMEOUT_MS);
    await assertion;
  });

  it("passes NarratorUnavailableError through and wraps other errors as unavailable", async () => {
    const offline: NarratorTransport = { complete: () => Promise.reject(new NarratorUnavailableError("offline", "down")) };
    const broken: NarratorTransport = { complete: () => Promise.reject(new TypeError("boom")) };
    await expect(createNarratorClient(offline).describeComponents(SAMPLE_BRIEFS)).rejects.toMatchObject({ reason: "offline" });
    await expect(createNarratorClient(broken).describeComponents(SAMPLE_BRIEFS)).rejects.toMatchObject({ reason: "unavailable", message: "boom" });
  });

  it("keeps sessionStory and decisionWhy for lane 07 (reason unsupported)", async () => {
    const { transport, requests } = capturing(() => answer({}));
    const client = createNarratorClient(transport);
    await expect(
      client.sessionStory({ prompt: "p", recentSteps: [], decisions: [], tests: null, touchedComponents: [] }),
    ).rejects.toMatchObject({ reason: "unsupported" });
    await expect(
      client.decisionWhy({ decisionId: "d", title: "t", options: [], answer: "a", nearby: [] }),
    ).rejects.toMatchObject({ reason: "unsupported" });
    expect(requests).toEqual([]);
  });
});

describe("createFakeNarratorClient", () => {
  it("plays a script of values, functions, errors and schema-invalid answers, and records calls", async () => {
    const boom = new Error("scripted failure");
    const fake = createFakeNarratorClient({
      describeComponents: [
        [{ id: DESKTOP_ID, purpose: "Value.", role: "ui", citations: [] }],
        (input: unknown) => (input as ComponentBrief[]).map((brief) => ({ id: brief.id })),
        boom,
        FAKE_SCHEMA_INVALID,
      ],
    });
    await expect(fake.describeComponents(SAMPLE_BRIEFS)).resolves.toMatchObject({ schemaValid: true, value: [{ id: DESKTOP_ID }] });
    await expect(fake.describeComponents(SAMPLE_BRIEFS.slice(0, 1))).resolves.toMatchObject({ value: [{ id: DESKTOP_ID }] });
    await expect(fake.describeComponents(SAMPLE_BRIEFS)).rejects.toBe(boom);
    await expect(fake.describeComponents(SAMPLE_BRIEFS)).resolves.toMatchObject({ schemaValid: false, value: [] });
    await expect(fake.describeComponents(SAMPLE_BRIEFS)).rejects.toThrow("no scripted response left for describeComponents");
    await expect(fake.overviewNarrative({ components: [], edges: [] })).rejects.toThrow("overviewNarrative");
    expect(fake.calls.map((call) => call.method)).toEqual([
      "describeComponents", "describeComponents", "describeComponents", "describeComponents", "describeComponents", "overviewNarrative",
    ]);
  });
});
