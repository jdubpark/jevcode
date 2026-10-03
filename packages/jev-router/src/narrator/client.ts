import { z } from "zod";

import { ROLES } from "@jevcode/contracts";
import type { NarrativeSentence } from "@jevcode/contracts";

import { NarratorUnavailableError, toNarratorError } from "./errors.js";
import {
  DESCRIBE_MAX_TOKENS,
  DESCRIBE_OUTPUT_JSON_SCHEMA,
  DESCRIBE_SYSTEM_PROMPT,
  OVERVIEW_MAX_TOKENS,
  OVERVIEW_SYSTEM_PROMPT,
  SENTENCES_OUTPUT_JSON_SCHEMA,
  buildDescribeState,
  buildOverviewState,
  citationsForKeys,
  clipChars,
} from "./prompts.js";
import type { KeyedState } from "./prompts.js";
import {
  DECISION_WHY_MAX_TOKENS,
  DECISION_WHY_SYSTEM_PROMPT,
  SESSION_STORY_MAX_TOKENS,
  SESSION_STORY_SYSTEM_PROMPT,
  buildDecisionWhyState,
  buildSessionStoryState,
} from "./session.js";
import { NARRATOR_MAX_BATCH, NARRATOR_MODEL, NARRATOR_TIMEOUT_MS } from "./types.js";
import type {
  DescribedComponent,
  NarratorCallOptions,
  NarratorClient,
  NarratorResult,
  NarratorTransport,
} from "./types.js";

const DescribeOutputSchema = z.object({
  components: z.array(
    z.object({ key: z.string(), purpose: z.string(), role: z.enum(ROLES), cite: z.array(z.string()) }),
  ),
});

const SentencesOutputSchema = z.object({
  sentences: z.array(z.object({ text: z.string(), cite: z.array(z.string()) })),
});

export interface NarratorQuestionSpec<T> {
  system: string;
  state: unknown;
  schema: Readonly<Record<string, unknown>>;
  maxTokens: number;
  /** Value returned when the answer fails the schema. */
  empty: T;
  /** Returns null when the answer does not match the schema. */
  parse(json: unknown): T | null;
}

export interface AskNarratorOptions {
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

/** One guarded round trip: timeout, caller abort, schema parse. Lane 07 S-1 reuses it. */
export async function askNarrator<T>(
  transport: NarratorTransport,
  spec: NarratorQuestionSpec<T>,
  options: AskNarratorOptions,
): Promise<NarratorResult<T>> {
  const now = options.now ?? Date.now;
  if (options.signal?.aborted === true) {
    throw new NarratorUnavailableError("aborted", "narrator call aborted before it started");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: () => void = () => undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new NarratorUnavailableError("timeout", `narrator call took longer than ${options.timeoutMs} ms`));
      controller.abort();
    }, options.timeoutMs);
    const signal = options.signal;
    if (signal !== undefined) {
      const onAbort = (): void => {
        reject(new NarratorUnavailableError("aborted", "narrator call aborted"));
        controller.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      detach = () => signal.removeEventListener("abort", onAbort);
    }
  });
  const started = now();
  try {
    const response = await Promise.race([
      transport.complete({
        model: options.model,
        system: spec.system,
        user: JSON.stringify(spec.state),
        schema: spec.schema,
        maxTokens: spec.maxTokens,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
      }),
      guard,
    ]);
    const parsed = response.json === undefined ? null : spec.parse(response.json);
    return {
      value: parsed ?? spec.empty,
      confidence: parsed === null ? 0 : 1,
      heuristic: false,
      model: response.model,
      ms: Math.max(0, now() - started),
      usage: response.usage,
      schemaValid: parsed !== null,
    };
  } catch (error) {
    throw toNarratorError(error);
  } finally {
    clearTimeout(timer);
    detach();
  }
}

function parseDescribed(json: unknown, keyed: KeyedState): DescribedComponent[] | null {
  const parsed = DescribeOutputSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.components.map((item) => ({
    id: keyed.componentByKey.get(item.key) ?? `unknown:${clipChars(item.key, 64)}`,
    purpose: item.purpose,
    role: item.role,
    citations: citationsForKeys(item.cite, keyed.cite),
  }));
}

function parseSentences(json: unknown, keyed: KeyedState): NarrativeSentence[] | null {
  const parsed = SentencesOutputSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.sentences.map((sentence) => ({
    text: sentence.text,
    citations: citationsForKeys(sentence.cite, keyed.cite),
  }));
}

function emptyResult<T>(value: T, model: string): NarratorResult<T> {
  return { value, confidence: 1, heuristic: false, model, ms: 0, usage: null, schemaValid: true };
}

export interface NarratorClientOptions {
  model?: string;
  timeoutMs?: number;
  now?: () => number;
}

export function createNarratorClient(transport: NarratorTransport, options: NarratorClientOptions = {}): NarratorClient {
  const model = options.model ?? NARRATOR_MODEL;
  const timeoutMs = options.timeoutMs ?? NARRATOR_TIMEOUT_MS;
  const ask = <T>(spec: NarratorQuestionSpec<T>, call?: NarratorCallOptions): Promise<NarratorResult<T>> =>
    askNarrator(transport, spec, { model, timeoutMs, signal: call?.signal, now: options.now });

  return {
    describeComponents(batch, call) {
      if (batch.length > NARRATOR_MAX_BATCH) {
        return Promise.reject(
          new RangeError(`describeComponents takes at most ${NARRATOR_MAX_BATCH} components, got ${batch.length}`),
        );
      }
      if (batch.length === 0) return Promise.resolve(emptyResult<DescribedComponent[]>([], model));
      const keyed = buildDescribeState(batch);
      return ask<DescribedComponent[]>(
        {
          system: DESCRIBE_SYSTEM_PROMPT,
          state: keyed.state,
          schema: DESCRIBE_OUTPUT_JSON_SCHEMA,
          maxTokens: DESCRIBE_MAX_TOKENS,
          empty: [],
          parse: (json) => parseDescribed(json, keyed),
        },
        call,
      );
    },
    overviewNarrative(input, call) {
      if (input.components.length === 0) return Promise.resolve(emptyResult<NarrativeSentence[]>([], model));
      const keyed = buildOverviewState(input);
      return ask<NarrativeSentence[]>(
        {
          system: OVERVIEW_SYSTEM_PROMPT,
          state: keyed.state,
          schema: SENTENCES_OUTPUT_JSON_SCHEMA,
          maxTokens: OVERVIEW_MAX_TOKENS,
          empty: [],
          parse: (json) => parseSentences(json, keyed),
        },
        call,
      );
    },
    sessionStory(input, call) {
      if (input.recentSteps.length === 0 && input.decisions.length === 0 && input.touchedComponents.length === 0) {
        return Promise.resolve(emptyResult<NarrativeSentence[]>([], model));
      }
      const keyed = buildSessionStoryState(input);
      return ask<NarrativeSentence[]>(
        {
          system: SESSION_STORY_SYSTEM_PROMPT,
          state: keyed.state,
          schema: SENTENCES_OUTPUT_JSON_SCHEMA,
          maxTokens: SESSION_STORY_MAX_TOKENS,
          empty: [],
          parse: (json) => parseSentences(json, keyed),
        },
        call,
      );
    },
    decisionWhy(input, call) {
      // No nearby message or plan step means nothing to ground a reason in: no call.
      if (input.nearby.length === 0) return Promise.resolve(emptyResult<NarrativeSentence | null>(null, model));
      const keyed = buildDecisionWhyState(input);
      // Schema-valid with no sentence is a legitimate "no reason found" (null, schemaValid true); only a
      // schema-invalid answer is schemaValid false.
      return ask<NarrativeSentence[]>(
        {
          system: DECISION_WHY_SYSTEM_PROMPT,
          state: keyed.state,
          schema: SENTENCES_OUTPUT_JSON_SCHEMA,
          maxTokens: DECISION_WHY_MAX_TOKENS,
          empty: [],
          parse: (json) => parseSentences(json, keyed),
        },
        call,
      ).then((result): NarratorResult<NarrativeSentence | null> => ({ ...result, value: result.value[0] ?? null }));
    },
  };
}

export const FAKE_SCHEMA_INVALID: unique symbol = Symbol("fake narrator schema-invalid answer");

export interface FakeNarratorCall {
  method: keyof NarratorClient;
  input: unknown;
  signal: AbortSignal | undefined;
}

export interface FakeNarratorClient extends NarratorClient {
  readonly calls: FakeNarratorCall[];
}

type FakeStep = (input: unknown, options?: NarratorCallOptions) => unknown;

/**
 * Test double (interfaces §4). Script entries per method, consumed in order: a value
 * (the call's `value`), an Error (rejects), a function (called with input and options;
 * may return a promise), or FAKE_SCHEMA_INVALID. A used-up script rejects.
 */
export function createFakeNarratorClient(script: Partial<Record<keyof NarratorClient, unknown[]>>): FakeNarratorClient {
  const queues = new Map<keyof NarratorClient, unknown[]>();
  for (const [method, steps] of Object.entries(script) as [keyof NarratorClient, unknown[] | undefined][]) {
    queues.set(method, [...(steps ?? [])]);
  }
  const calls: FakeNarratorCall[] = [];

  async function run(method: keyof NarratorClient, input: unknown, options?: NarratorCallOptions): Promise<NarratorResult<unknown>> {
    calls.push({ method, input, signal: options?.signal });
    const queue = queues.get(method);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`fake narrator: no scripted response left for ${method}`);
    }
    const step = queue.shift();
    if (step instanceof Error) throw step;
    const produced = typeof step === "function" ? await (step as FakeStep)(input, options) : step;
    if (produced === FAKE_SCHEMA_INVALID) {
      return {
        value: method === "decisionWhy" ? null : [],
        confidence: 0,
        heuristic: false,
        model: NARRATOR_MODEL,
        ms: 0,
        usage: null,
        schemaValid: false,
      };
    }
    return { value: produced, confidence: 1, heuristic: false, model: NARRATOR_MODEL, ms: 0, usage: null, schemaValid: true };
  }

  return {
    calls,
    describeComponents: (batch, options) =>
      run("describeComponents", batch, options) as Promise<NarratorResult<DescribedComponent[]>>,
    overviewNarrative: (input, options) =>
      run("overviewNarrative", input, options) as Promise<NarratorResult<NarrativeSentence[]>>,
    sessionStory: (input, options) => run("sessionStory", input, options) as Promise<NarratorResult<NarrativeSentence[]>>,
    decisionWhy: (input, options) => run("decisionWhy", input, options) as Promise<NarratorResult<NarrativeSentence | null>>,
  };
}
