import type { AttentionDecision, JevResult, UIIntent } from "@jevcode/contracts";
import { TypeSafeClient as SdkClient } from "@typesafe-ai/sdk";

import { clampAttention, clampProjection, preClampAttention } from "./guardrails.js";
import {
  attentionConfidence,
  mapAttention,
  mapProjection,
  passAAnswersFrom,
  passBAnswersFrom,
  projectionConfidence,
} from "./mapping.js";
import { renderPolicy } from "./policy.js";
import { composeAttentionRequest, composeProjectionRequest } from "./questions.js";
import { chunkAttentionBatch, MAX_ATTENTION_BATCH } from "./batch.js";
import { degradeAttention, degradeProjection } from "./degrade.js";
import type {
  AttentionInput,
  EnvReader,
  JevClient,
  JevHealth,
  ProjectionInput,
  SystemOneResultLike,
  SystemOneRequestLike,
  TypeSafeQuestion,
  TypeSafeTransport,
} from "./types.js";
import { TYPESAFE_CLIENT_KIND } from "./types.js";

export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_API_KEY_ENV = "JEV_API_KEY";

export function defaultEnvReader(): Record<string, string | undefined> {
  const key = process.env[JEV_API_KEY_ENV] ?? process.env[TYPESAFE_API_KEY_ENV];
  return {
    TYPESAFE_API_KEY: key,
    JEV_API_KEY: process.env[JEV_API_KEY_ENV],
    TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL,
    TYPESAFE_DEFAULT_MODEL: process.env.TYPESAFE_DEFAULT_MODEL,
  };
}

export class SdkTransport implements TypeSafeTransport {
  private client: SdkClient | null = null;
  private readonly env: EnvReader;
  private readonly model: string | undefined;

  constructor(env: EnvReader, model?: string) {
    this.env = env;
    this.model = model;
  }

  private getClient(): SdkClient {
    if (this.client === null) {
      const env = this.env();
      const apiKey = env[TYPESAFE_API_KEY_ENV];
      if (apiKey === undefined || apiKey.trim().length === 0) {
        throw new Error("JEV_API_KEY (or TYPESAFE_API_KEY) is not set");
      }
      this.client = new SdkClient({
        apiKey,
        baseURL: env.TYPESAFE_BASE_URL,
        defaultModel: this.model ?? env.TYPESAFE_DEFAULT_MODEL,
        logLevel: "off",
      });
    }
    return this.client;
  }

  async systemOne(request: SystemOneRequestLike): Promise<SystemOneResultLike> {
    const response = await this.getClient().systemOne(
      request as Parameters<SdkClient["systemOne"]>[0],
    );
    return response as unknown as SystemOneResultLike;
  }
}

export interface TypeSafeClientOptions {
  transport?: TypeSafeTransport;
  env?: EnvReader;
  model?: string;
  retries?: number;
}

export class TypeSafeClient implements JevClient {
  private readonly transport: TypeSafeTransport;
  private readonly env: EnvReader;
  private readonly model: string | undefined;
  private readonly retries: number;

  constructor(options: TypeSafeClientOptions = {}) {
    this.env = options.env ?? defaultEnvReader;
    this.model = options.model;
    this.retries = options.retries ?? 1;
    this.transport = options.transport ?? new SdkTransport(this.env, this.model);
  }

  async attention(
    batch: AttentionInput[],
  ): Promise<JevResult<AttentionDecision>[]> {
    if (batch.length === 0) return [];
    const results: JevResult<AttentionDecision>[] = [];
    for (const chunk of chunkAttentionBatch(batch, MAX_ATTENTION_BATCH)) {
      results.push(...(await this.attentionChunk(chunk)));
    }
    return results;
  }

  private async attentionChunk(
    chunk: AttentionInput[],
  ): Promise<JevResult<AttentionDecision>[]> {
    const { state, questions } = composeAttentionRequest(chunk);
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const answers = await this.fetchAnswers(state, questions);
        return this.mapAttentionChunk(chunk, answers);
      } catch {
        if (attempt >= this.retries) break;
      }
    }
    return chunk.map((input) => degradeAttention(input));
  }

  private mapAttentionChunk(
    chunk: AttentionInput[],
    answers: Record<string, unknown>,
  ): JevResult<AttentionDecision>[] {
    return chunk.map((input, index) => {
      const passA = passAAnswersFrom(answers, `u${index}`);
      const pre = preClampAttention(input);
      const model = mapAttention(passA);
      const clamped = clampAttention(input, model, pre);
      return {
        value: clamped.value,
        confidence: attentionConfidence(passA),
        probabilities: clamped.value.probabilities,
        clientKind: TYPESAFE_CLIENT_KIND,
        heuristic: false,
      };
    });
  }

  async project(input: ProjectionInput): Promise<JevResult<UIIntent>> {
    const { state, questions } = composeProjectionRequest(input);
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const answers = await this.fetchAnswers(state, questions);
        const passB = passBAnswersFrom(answers);
        const mapped = mapProjection(passB, input);
        const clamped = clampProjection(input, mapped);
        return renderPolicy({
          value: clamped.value,
          confidence: projectionConfidence(passB),
          clientKind: TYPESAFE_CLIENT_KIND,
          heuristic: false,
        });
      } catch {
        if (attempt >= this.retries) break;
      }
    }
    return degradeProjection(input);
  }

  async health(): Promise<JevHealth> {
    const env = this.env();
    const apiKey = env[TYPESAFE_API_KEY_ENV];
    return apiKey !== undefined && apiKey.trim().length > 0 ? "ok" : "degraded";
  }

  private async fetchAnswers(
    state: unknown,
    questions: Record<string, TypeSafeQuestion>,
  ): Promise<Record<string, unknown>> {
    const result = await this.transport.systemOne({
      state,
      questions,
      model: this.model,
    });
    return result.answers;
  }
}
