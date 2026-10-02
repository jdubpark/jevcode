import Anthropic from "@anthropic-ai/sdk";

import { NarratorUnavailableError } from "./errors.js";
import type { NarratorTransport } from "./types.js";

export interface AnthropicNarratorTransportOptions {
  apiKey: string;
  /** Test-only override; production always talks to api.anthropic.com. */
  baseURL?: string;
  /** Test seam: replaces global fetch (recorded responses; no network in tests). */
  fetch?: typeof fetch;
}

/** Most specific SDK error first (claude-api skill: catch a chain, not one broad class). */
export function anthropicErrorToNarrator(error: unknown): NarratorUnavailableError {
  if (error instanceof NarratorUnavailableError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new NarratorUnavailableError("aborted", "narrator call aborted");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new NarratorUnavailableError("timeout", "narrator call timed out");
  if (error instanceof Anthropic.APIConnectionError) return new NarratorUnavailableError("offline", "narrator provider is unreachable");
  if (error instanceof Anthropic.RateLimitError) return new NarratorUnavailableError("rate_limited", "narrator provider rate-limited the call");
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new NarratorUnavailableError("auth", "narrator provider rejected the API key");
  }
  if (error instanceof Anthropic.APIError) {
    return new NarratorUnavailableError("unavailable", `narrator provider error ${String(error.status)}`);
  }
  return new NarratorUnavailableError("unavailable", error instanceof Error ? error.message : String(error));
}

/** Messages API with a JSON-schema output format; retries are owned by the explainer's backoff. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** The SDK merges ANTHROPIC_CUSTOM_HEADERS from the environment; a null value removes a header. */
function suppressedEnvHeaders(): Record<string, null> {
  const suppressed: Record<string, null> = {};
  for (const line of (process.env["ANTHROPIC_CUSTOM_HEADERS"] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon >= 0) suppressed[line.substring(0, colon).trim()] = null;
  }
  return suppressed;
}

export function createAnthropicNarratorTransport(options: AnthropicNarratorTransportOptions): NarratorTransport {
  if (options.apiKey.trim() === "") {
    throw new NarratorUnavailableError("auth", "narrator needs an API key");
  }
  const client = new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    baseURL: options.baseURL ?? ANTHROPIC_BASE_URL,
    defaultHeaders: suppressedEnvHeaders(),
    maxRetries: 0,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return {
    async complete(request) {
      const message = await client.messages
        .create(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
            output_config: { format: { type: "json_schema", schema: request.schema } },
          },
          { timeout: request.timeoutMs, signal: request.signal },
        )
        .catch((error: unknown) => {
          throw anthropicErrorToNarrator(error);
        });
      const block = message.content.find((candidate) => candidate.type === "text");
      const text = block !== undefined && block.type === "text" ? block.text : undefined;
      let json: unknown = undefined;
      if (message.stop_reason === "end_turn" && text !== undefined) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      return {
        json,
        model: message.model,
        stopReason: message.stop_reason,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    },
  };
}
