import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createNarratorClient } from "./client.js";
import { NarratorUnavailableError } from "./errors.js";
import { plainTextViolation } from "./guardrails.js";
import { SENTENCES_OUTPUT_JSON_SCHEMA } from "./prompts.js";
import {
  DECISION_WHY_SYSTEM_PROMPT,
  SESSION_LIMITS,
  SESSION_STORY_SYSTEM_PROMPT,
  buildSessionStoryState,
  decisionWhyUniverse,
  guardDecisionWhy,
  guardSessionStory,
  sessionStoryUniverse,
} from "./session.js";
import { NARRATOR_MODEL } from "./types.js";
import type { DecisionWhyInput, NarratorTransport, NarratorTransportRequest, SessionStoryInput } from "./types.js";

interface Recorded<I> {
  input: I;
  output: unknown;
}

function recorded<I>(name: string): Recorded<I> {
  return JSON.parse(readFileSync(new URL(`./recorded/${name}.json`, import.meta.url), "utf8")) as Recorded<I>;
}

const story = recorded<SessionStoryInput>("session-story.rate-limit");
const hostile = recorded<SessionStoryInput>("session-story.hostile");
const why = recorded<DecisionWhyInput>("decision-why.rate-limit");

function answering(json: unknown): { transport: NarratorTransport; requests: NarratorTransportRequest[] } {
  const requests: NarratorTransportRequest[] = [];
  return {
    requests,
    transport: {
      async complete(request) {
        requests.push(request);
        return { json, model: NARRATOR_MODEL, stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 120 } };
      },
    },
  };
}

describe("sessionStory", () => {
  it("maps the recorded keyed answer to step, decision and component ids that pass the guard", async () => {
    const { transport, requests } = answering(story.output);
    const result = await createNarratorClient(transport).sessionStory(story.input);
    expect(result.schemaValid).toBe(true);
    expect(result.value.map((s) => s.citations)).toEqual([
      [{ kind: "component", id: "cmp_3f1a2b4c5d6e" }, { kind: "step", id: "step:12" }],
      [{ kind: "decision", id: "dec_redis_policy" }],
      [{ kind: "step", id: "step:19" }],
    ]);
    const guard = guardSessionStory(result.value, story.input);
    expect(guard).toMatchObject({ dropped: 0, discarded: false });
    expect(guard.accepted).toHaveLength(3);
    for (const sentence of guard.accepted) expect(plainTextViolation(sentence.text)).toBeNull();
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(result.model).toBe(NARRATOR_MODEL);
    expect(requests[0]?.system).toBe(SESSION_STORY_SYSTEM_PROMPT);
    expect(requests[0]?.schema).toBe(SENTENCES_OUTPUT_JSON_SCHEMA);
  });

  it("sends keys and clipped metadata only, never the ids", async () => {
    const long: SessionStoryInput = {
      prompt: "p".repeat(5_000),
      recentSteps: Array.from({ length: 20 }, (_, i) => ({ id: `step:${i + 1}`, headline: "h".repeat(400) })),
      decisions: [{ id: "dec_secret", title: "t".repeat(500), status: "answered", answer: "a".repeat(500) }],
      tests: null,
      touchedComponents: [{ id: "cmp_000000000001", name: "n".repeat(300) }],
    };
    const { transport, requests } = answering({ sentences: [] });
    await createNarratorClient(transport).sessionStory(long);
    const user = requests[0]?.user ?? "";
    expect(user).not.toMatch(/step:\d|dec_secret|cmp_000000000001/);
    const state = JSON.parse(user) as {
      prompt: string;
      steps: { key: string; headline: string }[];
      decisions: { key: string }[];
      components: { key: string }[];
    };
    expect(state.prompt).toHaveLength(SESSION_LIMITS.promptChars);
    expect(state.steps.map((step) => step.key)).toEqual(Array.from({ length: 12 }, (_, i) => `s${i + 1}`));
    expect(Math.max(...state.steps.map((step) => step.headline.length))).toBe(SESSION_LIMITS.headlineChars);
    expect(state.decisions.map((decision) => decision.key)).toEqual(["d1"]);
    expect((state.decisions[0] as unknown as { answer: string }).answer).toHaveLength(SESSION_LIMITS.titleChars);
    expect(state.components.map((component) => component.key)).toEqual(["c1"]);
    expect(buildSessionStoryState(long).cite.get("s1")).toEqual({ kind: "step", id: "step:9" });
  });

  it("discards the hostile recording: a URL, Markdown, an uncited sentence and an unknown key are dropped", async () => {
    const { transport } = answering(hostile.output);
    const result = await createNarratorClient(transport).sessionStory(story.input);
    const guard = guardSessionStory(result.value, story.input);
    expect(guard.total).toBe(5);
    expect(guard.dropped).toBe(4);
    expect(guard.discarded).toBe(true);
    expect(guard.reasons).toEqual(["0:markup", "1:markup", "2:uncited", "3:unresolved_citation", "batch_discarded"]);
  });

  it("sends the chosen answer and a citable test key", async () => {
    const { transport, requests } = answering({ sentences: [] });
    await createNarratorClient(transport).sessionStory(story.input);
    const state = JSON.parse(requests[0]?.user ?? "{}") as { decisions: { answer: string }[]; tests: { key: string; passed: number } };
    expect(state.decisions[0]?.answer).toBe("Fail open");
    expect(state.tests).toEqual({ key: "t1", passed: 14, failed: 1 });
    expect(buildSessionStoryState(story.input).cite.get("t1")).toEqual({ kind: "step", id: "step:19" });
  });

  it("makes no call for an empty session and rejects when the transport fails", async () => {
    const { transport, requests } = answering({ sentences: [] });
    const empty = await createNarratorClient(transport).sessionStory({
      prompt: "p",
      recentSteps: [],
      decisions: [],
      tests: null,
      touchedComponents: [],
    });
    expect(empty.value).toEqual([]);
    expect(requests).toHaveLength(0);
    const offline: NarratorTransport = { complete: () => Promise.reject(new NarratorUnavailableError("offline", "down")) };
    await expect(createNarratorClient(offline).sessionStory(story.input)).rejects.toBeInstanceOf(NarratorUnavailableError);
  });
});

describe("decisionWhy", () => {
  it("maps n1 and d1 to the nearby step and the decision, and the guard accepts the one sentence", async () => {
    const { transport, requests } = answering(why.output);
    const result = await createNarratorClient(transport).decisionWhy(why.input);
    expect(result.value?.citations).toEqual([{ kind: "step", id: "step:14" }, { kind: "decision", id: "dec_redis_policy" }]);
    expect(guardDecisionWhy(result.value, why.input).accepted).toHaveLength(1);
    expect(requests[0]?.system).toBe(DECISION_WHY_SYSTEM_PROMPT);
    const sent = JSON.parse(requests[0]?.user ?? "{}") as { chosenBy: string; nearby: { key: string; text: string }[] };
    expect(sent.nearby.map((item) => item.key)).toEqual(["n1", "n2", "n3"]);
    expect(sent.chosenBy).toBe("developer");
  });

  it("sends no ids and clips nearby text to 600 characters", async () => {
    const { transport, requests } = answering(why.output);
    await createNarratorClient(transport).decisionWhy({
      ...why.input,
      nearby: [{ id: "step:77", kind: "message", text: "x".repeat(2_000) }],
    });
    const user = requests[0]?.user ?? "";
    expect(user).not.toMatch(/step:\d|dec_redis_policy|fail_open/);
    const sent = JSON.parse(user) as { nearby: { text: string }[] };
    expect(sent.nearby[0]?.text).toHaveLength(SESSION_LIMITS.nearbyChars);
  });

  it("rejects when the transport fails", async () => {
    const offline: NarratorTransport = { complete: () => Promise.reject(new NarratorUnavailableError("offline", "down")) };
    await expect(createNarratorClient(offline).decisionWhy(why.input)).rejects.toBeInstanceOf(NarratorUnavailableError);
  });

  it("makes no call and resolves null when nothing is nearby", async () => {
    const { transport, requests } = answering(why.output);
    const result = await createNarratorClient(transport).decisionWhy({ ...why.input, nearby: [] });
    expect(result).toMatchObject({ value: null, schemaValid: true });
    expect(requests).toHaveLength(0);
  });

  it("drops a sentence that cites only the decision", () => {
    const only = { text: "Failing open keeps the API available.", citations: [{ kind: "decision", id: "dec_redis_policy" }] };
    expect(guardDecisionWhy(only, why.input)).toMatchObject({ accepted: [], dropped: 1, discarded: true });
    const grounded = { ...only, citations: [...only.citations, { kind: "step", id: "step:14" }] };
    expect(guardDecisionWhy(grounded, why.input).accepted).toHaveLength(1);
  });

  it("resolves null with schemaValid true for an empty sentences array and false for a malformed answer", async () => {
    const { transport } = answering({ sentences: [] });
    const result = await createNarratorClient(transport).decisionWhy(why.input);
    expect(result.value).toBeNull();
    expect(result.schemaValid).toBe(true);
    const bad = await createNarratorClient(answering({ nonsense: 1 }).transport).decisionWhy(why.input);
    expect(bad).toMatchObject({ value: null, schemaValid: false });
    expect(guardDecisionWhy(result.value, why.input).accepted).toEqual([]);
  });
});

describe("universes", () => {
  it("hold only the ids the state shows", () => {
    const universe = sessionStoryUniverse(story.input);
    expect([...universe.steps]).toEqual(["step:3", "step:9", "step:12", "step:15", "step:19"]);
    expect([...universe.components]).toEqual(["cmp_3f1a2b4c5d6e", "cmp_9a8b7c6d5e4f"]);
    expect([...universe.decisions]).toEqual(["dec_redis_policy"]);
    expect(universe.files.size + universe.facts.size).toBe(0);
    const whyUniverse = decisionWhyUniverse(why.input);
    expect([...whyUniverse.steps]).toEqual(["step:14", "step:8", "step:16"]);
    expect([...whyUniverse.decisions]).toEqual(["dec_redis_policy"]);
  });
});
