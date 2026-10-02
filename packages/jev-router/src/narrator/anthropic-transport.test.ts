import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_ID,
  RECORDED_DESCRIBE_MESSAGE,
  RECORDED_OVERVIEW_MESSAGE,
  SAMPLE_BRIEFS,
  universeFor,
} from "../testing/narrator-recorded.js";
import { anthropicErrorToNarrator, createAnthropicNarratorTransport } from "./anthropic-transport.js";
import { createNarratorClient } from "./client.js";
import { NarratorUnavailableError } from "./errors.js";
import { guardComponents, guardSentences } from "./guardrails.js";
import { DESCRIBE_MAX_TOKENS, DESCRIBE_OUTPUT_JSON_SCHEMA, DESCRIBE_SYSTEM_PROMPT } from "./prompts.js";
import { NARRATOR_MODEL } from "./types.js";

function recordedFetch(body: unknown, status = 200) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "request-id": "req_recorded" },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, calls: fetchImpl };
}

describe("recorded responses through the Anthropic transport (spec §12)", () => {
  it("describeComponents: posts one structured-output request and maps the recorded answer", async () => {
    const { fetchImpl, seen } = recordedFetch(RECORDED_DESCRIBE_MESSAGE);
    const transport = createAnthropicNarratorTransport({ apiKey: "sk-ant-test-key", fetch: fetchImpl });
    const result = await createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/\/v1\/messages$/);
    expect(new Headers(seen[0]!.init?.headers as ConstructorParameters<typeof Headers>[0]).get("x-api-key")).toBe("sk-ant-test-key");
    const body = JSON.parse(String(seen[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: NARRATOR_MODEL,
      max_tokens: DESCRIBE_MAX_TOKENS,
      system: DESCRIBE_SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: DESCRIBE_OUTPUT_JSON_SCHEMA } },
    });
    expect(body["messages"]).toEqual([{ role: "user", content: expect.any(String) }]);

    expect(result).toMatchObject({ schemaValid: true, model: NARRATOR_MODEL, usage: { inputTokens: 1184, outputTokens: 162 } });
    const guarded = guardComponents(result.value, universeFor(SAMPLE_BRIEFS), SAMPLE_BRIEFS.map((brief) => brief.id));
    expect(guarded).toMatchObject({ total: 3, dropped: 0, discarded: false });
    expect(guarded.accepted[0]).toEqual({
      id: DESKTOP_ID,
      purpose: "Electron app that opens the windows, routes IPC and runs the agent pipeline.",
      role: "api",
      citations: [
        { kind: "component", id: DESKTOP_ID },
        { kind: "file", id: "apps/desktop/src/main/index.ts" },
        { kind: "file", id: "apps/desktop/src/main/ipc.ts" },
      ],
    });
  });

  it("overviewNarrative: maps the recorded sentences and passes the guard", async () => {
    const { fetchImpl } = recordedFetch(RECORDED_OVERVIEW_MESSAGE);
    const client = createNarratorClient(createAnthropicNarratorTransport({ apiKey: "k", fetch: fetchImpl }));
    const result = await client.overviewNarrative({
      components: SAMPLE_BRIEFS.map((brief) => ({ id: brief.id, name: brief.name, role: brief.roleGuess, purpose: null })),
      edges: [],
    });
    const guarded = guardSentences(result.value, universeFor(SAMPLE_BRIEFS), { max: 8 });
    expect(guarded).toMatchObject({ total: 4, dropped: 0, discarded: false });
  });

  it("treats a max_tokens stop as a schema failure", async () => {
    const { fetchImpl } = recordedFetch({ ...RECORDED_DESCRIBE_MESSAGE, stop_reason: "max_tokens" });
    const client = createNarratorClient(createAnthropicNarratorTransport({ apiKey: "k", fetch: fetchImpl }));
    await expect(client.describeComponents(SAMPLE_BRIEFS)).resolves.toMatchObject({ schemaValid: false, value: [] });
  });
});

describe("provider errors map to NarratorFailureReason without SDK retries", () => {
  it.each([
    [429, "rate_limited", { type: "error", error: { type: "rate_limit_error", message: "slow down" } }],
    [401, "auth", { type: "error", error: { type: "authentication_error", message: "bad key" } }],
    [500, "unavailable", { type: "error", error: { type: "api_error", message: "oops" } }],
  ])("HTTP %i → %s, one attempt", async (status, reason, body) => {
    const { fetchImpl, calls } = recordedFetch(body, status);
    const transport = createAnthropicNarratorTransport({ apiKey: "k", fetch: fetchImpl });
    await expect(createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS)).rejects.toMatchObject({ reason });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to offline", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const transport = createAnthropicNarratorTransport({ apiKey: "k", fetch: fetchImpl });
    await expect(createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS)).rejects.toMatchObject({ reason: "offline" });
  });

  it("maps the SDK's own timeout to timeout", async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const transport = createAnthropicNarratorTransport({ apiKey: "k", fetch: hanging });
    await expect(
      transport.complete({
        model: NARRATOR_MODEL,
        system: "s",
        user: "{}",
        schema: DESCRIBE_OUTPUT_JSON_SCHEMA,
        maxTokens: 10,
        timeoutMs: 50,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("keeps an existing NarratorUnavailableError and wraps unknown values", () => {
    const original = new NarratorUnavailableError("auth", "x");
    expect(anthropicErrorToNarrator(original)).toBe(original);
    expect(anthropicErrorToNarrator("weird")).toMatchObject({ reason: "unavailable", message: "weird" });
  });
});

describe("ambient environment cannot redirect or re-authenticate the call", () => {
  const KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of KEYS) saved.set(key, process.env[key]);
    process.env["ANTHROPIC_AUTH_TOKEN"] = "ambient-token";
    process.env["ANTHROPIC_BASE_URL"] = "https://evil.example";
    process.env["ANTHROPIC_CUSTOM_HEADERS"] = "X-Evil: 1\nX-Other: 2";
  });
  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("sends only x-api-key to api.anthropic.com with no custom header", async () => {
    const { fetchImpl, seen } = recordedFetch(RECORDED_DESCRIBE_MESSAGE);
    const transport = createAnthropicNarratorTransport({ apiKey: "sk-ant-real", fetch: fetchImpl });
    await createNarratorClient(transport).describeComponents(SAMPLE_BRIEFS);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).host).toBe("api.anthropic.com");
    const headers = new Headers(seen[0]!.init?.headers as ConstructorParameters<typeof Headers>[0]);
    expect(headers.get("x-api-key")).toBe("sk-ant-real");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-evil")).toBe(false);
    expect(headers.has("x-other")).toBe(false);
  });

  it("refuses a blank key with reason auth and makes no call", () => {
    const { fetchImpl, calls } = recordedFetch(RECORDED_DESCRIBE_MESSAGE);
    for (const apiKey of ["", "   "]) {
      expect(() => createAnthropicNarratorTransport({ apiKey, fetch: fetchImpl })).toThrow(NarratorUnavailableError);
    }
    expect(calls).not.toHaveBeenCalled();
  });
});
