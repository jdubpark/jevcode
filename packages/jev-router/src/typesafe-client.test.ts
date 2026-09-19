import { describe, expect, it, vi } from "vitest";

import type {
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
  SystemOneRequestLike,
  SystemOneResultLike,
  TypeSafeTransport,
} from "./types.js";
import { TypeSafeClient, defaultEnvReader } from "./typesafe-client.js";
import { makeInput, makeProjectionInput } from "./testing/inputs.js";

function choice(
  choiceValue: string,
  probabilities: Record<string, number>,
  confidence = 0.9,
): ChoiceAnswer {
  return { type: "choice", choice: choiceValue, confidence, probabilities };
}

function score(scoreValue: number, confidence = 0.9): ScoreAnswer {
  return { type: "score", score: scoreValue, confidence, probabilities: {} };
}

function noul(probability: number): NoulAnswer {
  return { type: "noul", noul: probability };
}

function passAAnswersFor(index: number, category = "implementation_change"): Record<string, unknown> {
  const answers: Record<string, unknown> = {
    [`u${index}:should_surface`]: noul(0.8),
    [`u${index}:semantic_category`]: choice(category, { [category]: 0.85, implementation_change: 0.15 }),
    [`u${index}:importance`]: score(3),
    [`u${index}:relevance`]: score(3),
    [`u${index}:interruption`]: score(0),
    [`u${index}:mental_model_change`]: score(2),
    [`u${index}:scope`]: choice("module", {}),
    [`u${index}:human_decision`]: choice("none", {}),
    [`u${index}:needs_system2`]: noul(0.2),
  };
  return answers;
}

function passBAnswers(): Record<string, unknown> {
  return {
    representation: choice("summary", { summary: 0.92, diff: 0.08 }),
    attention: choice("surface", {}),
    density: choice("detailed", {}),
    show_evidence: noul(0.9),
    show_code: noul(0.1),
    "secondary:CodeDiff": noul(0.8),
    "secondary:TestMatrix": noul(0.3),
  };
}

interface FakeTransport extends TypeSafeTransport {
  calls: SystemOneRequestLike[];
  result: () => SystemOneResultLike;
}

function fakeTransport(result: () => SystemOneResultLike): FakeTransport {
  const calls: SystemOneRequestLike[] = [];
  return {
    calls,
    result,
    async systemOne(request) {
      calls.push(request);
      return result();
    },
  };
}

const noKeyEnv = () => ({ TYPESAFE_API_KEY: undefined });
const keyEnv = () => ({ TYPESAFE_API_KEY: "test-key" });

describe("TypeSafeClient.attention batching", () => {
  it("sends all units in ONE request with all Pass A questions", async () => {
    const transport = fakeTransport(() => ({
      answers: { ...passAAnswersFor(0), ...passAAnswersFor(1) },
    }));
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    const results = await client.attention([
      makeInput({ changeUnitId: "cu-1" }),
      makeInput({ changeUnitId: "cu-2" }),
    ]);
    expect(transport.calls).toHaveLength(1);
    const questions = Object.keys(transport.calls[0]?.questions ?? {});
    expect(questions).toHaveLength(18);
    expect(questions).toContain("u0:should_surface");
    expect(questions).toContain("u1:needs_system2");
    expect(results).toHaveLength(2);
    expect(results[0]?.value.shouldSurface).toBe(true);
    expect(results[0]?.confidence).toBe(0.9);
    expect(results[0]?.clientKind).toBe("typesafe");
    expect(results[0]?.heuristic).toBe(false);
  });

  it("chunks batches over 8 units into multiple requests", async () => {
    const transport = fakeTransport(() => ({
      answers: Object.assign(
        {},
        ...Array.from({ length: 9 }, (_, i) => passAAnswersFor(i)),
      ),
    }));
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    const results = await client.attention(
      Array.from({ length: 9 }, (_, i) => makeInput({ changeUnitId: `cu-${i}` })),
    );
    expect(transport.calls).toHaveLength(2);
    expect(results).toHaveLength(9);
    const first = Object.keys(transport.calls[0]?.questions ?? {});
    expect(first.filter((k) => k.endsWith(":should_surface"))).toHaveLength(8);
  });

  it("returns [] for an empty batch without any call", async () => {
    const transport = fakeTransport(() => ({ answers: {} }));
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    expect(await client.attention([])).toEqual([]);
    expect(transport.calls).toHaveLength(0);
  });

  it("applies guardrail clamps to model output (destructive)", async () => {
    const transport = fakeTransport(() => ({
      answers: {
        ...passAAnswersFor(0),
        "u0:human_decision": choice("none", {}),
        "u0:interruption": score(0),
      },
    }));
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    const [result] = await client.attention([
      makeInput({ hints: { destructiveCommands: ["rm -rf build"] } }),
    ]);
    expect(result?.value.humanDecision).toBe("required");
    expect(result?.value.interruption).toBeGreaterThanOrEqual(0.9);
    expect(result?.value.shouldSurface).toBe(true);
  });
});

describe("TypeSafeClient retry and fallback", () => {
  it("retries once on transport failure, then falls back to deterministic defaults", async () => {
    const transport = fakeTransport(() => {
      throw new Error("network down");
    });
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    const [result] = await client.attention([makeInput({})]);
    expect(transport.calls).toHaveLength(2);
    expect(result?.heuristic).toBe(true);
    expect(result?.confidence).toBe(0.6);
    expect(result?.value.shouldSurface).toBe(true);
  });

  it("retries once on schema failure (missing answers), then falls back", async () => {
    const transport = fakeTransport(() => ({ answers: {} }));
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    const [result] = await client.attention([makeInput({})]);
    expect(transport.calls).toHaveLength(2);
    expect(result?.heuristic).toBe(true);
  });

  it("recovers when the retry succeeds", async () => {
    let attempt = 0;
    const transport = fakeTransport(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return { answers: passAAnswersFor(0) };
    });
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    const [result] = await client.attention([makeInput({})]);
    expect(transport.calls).toHaveLength(2);
    expect(result?.heuristic).toBe(false);
  });
});

describe("TypeSafeClient.project", () => {
  it("composes Pass B questions in one request and applies the policy", async () => {
    const transport = fakeTransport(() => ({ answers: passBAnswers() }));
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    const result = await client.project(makeProjectionInput());
    const questions = Object.keys(transport.calls[0]?.questions ?? {});
    expect(questions).toHaveLength(16);
    expect(questions).toContain("representation");
    expect(questions).toContain("secondary:Terminal");
    expect(result.value.representation).toBe("summary");
    expect(result.value.secondaryViews).toEqual(["CodeDiff"]);
    expect(result.confidence).toBe(0.9);
    expect(result.value.renderMode).toBe("autonomous");
  });

  it("falls back to degrade projection on persistent failure", async () => {
    const transport = fakeTransport(() => {
      throw new Error("down");
    });
    const client = new TypeSafeClient({ transport, env: noKeyEnv });
    const result = await client.project(makeProjectionInput());
    expect(transport.calls).toHaveLength(2);
    expect(result.heuristic).toBe(true);
    expect(result.value.representation).toBe("summary");
  });
});

describe("TypeSafeClient.health", () => {
  it("returns degraded when no API key is present", async () => {
    const client = new TypeSafeClient({ env: noKeyEnv });
    expect(await client.health()).toBe("degraded");
  });

  it("returns ok when a key is present", async () => {
    const client = new TypeSafeClient({ env: keyEnv });
    expect(await client.health()).toBe("ok");
  });
});

describe("defaultEnvReader", () => {
  it("reads TYPESAFE_* variables from process.env", () => {
    const saved = process.env.TYPESAFE_API_KEY;
    try {
      process.env.TYPESAFE_API_KEY = "abc";
      expect(defaultEnvReader().TYPESAFE_API_KEY).toBe("abc");
      delete process.env.TYPESAFE_API_KEY;
      expect(defaultEnvReader().TYPESAFE_API_KEY).toBeUndefined();
    } finally {
      process.env.TYPESAFE_API_KEY = saved;
    }
  });
});

describe("transport isolation", () => {
  it("never calls the SDK when a fake transport is injected", async () => {
    const spy = vi.fn();
    const transport: TypeSafeTransport = {
      async systemOne() {
        spy();
        return { answers: passAAnswersFor(0) };
      },
    };
    const client = new TypeSafeClient({ transport, env: keyEnv });
    await client.attention([makeInput({})]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
