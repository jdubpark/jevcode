import { DegradeClient } from "./degrade.js";
import { TypeSafeClient, defaultEnvReader } from "./typesafe-client.js";
import type { EnvReader, JevClient, TypeSafeTransport } from "./types.js";
import { JEV_API_KEY_ENV, TYPESAFE_API_KEY_ENV } from "./typesafe-client.js";

export type ClientSelection = "typesafe" | "degrade" | "auto";

export const JEVC_JEV_CLIENT_ENV = "JEVC_JEV_CLIENT";

export function selectClientKind(
  env: Record<string, string | undefined>,
): "typesafe" | "degrade" {
  const configured = env[JEVC_JEV_CLIENT_ENV];
  if (configured === "typesafe") return "typesafe";
  if (configured === "degrade") return "degrade";
  const apiKey = env[TYPESAFE_API_KEY_ENV] ?? env[JEV_API_KEY_ENV];
  return apiKey !== undefined && apiKey.trim().length > 0 ? "typesafe" : "degrade";
}

export interface CreateJevClientOptions {
  env?: EnvReader;
  transport?: TypeSafeTransport;
  model?: string;
}

export function createJevClient(options: CreateJevClientOptions = {}): JevClient {
  const env = options.env ?? defaultEnvReader;
  const kind = selectClientKind(env());
  if (kind === "degrade") {
    return new DegradeClient();
  }
  return new TypeSafeClient({
    env,
    transport: options.transport,
    model: options.model,
  });
}
