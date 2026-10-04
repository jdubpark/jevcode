import { jevClientEnvValue, jevClientOverride } from "../shared/prefs.js";
import type { JevClientOption } from "../shared/prefs.js";

export interface JevEnvInput {
  /** The active TypeSafe key as the secrets store resolves it (saved, else TYPESAFE_API_KEY, else JEV_API_KEY), or null. */
  typesafeKey: string | null;
  /** The Settings page's stored Jev decisions client. */
  jevClientPreference: JevClientOption;
  /** The process environment, for JEVC_JEV_CLIENT and the TypeSafe endpoint settings. */
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * The environment jev-router's createJevClient reads for one session's Jev client and its model selection.
 * JEVC_JEV_CLIENT follows the rule the Settings page shows: a recognised environment value (typesafe, degrade) wins,
 * else the stored choice; auto leaves it out, so jev-router picks TypeSafe exactly when a key is active. Any other
 * environment value (empty, auto, offline) is ignored, as the page ignores it.
 */
export function jevEnv({ typesafeKey, jevClientPreference, env }: JevEnvInput): Record<string, string | undefined> {
  const client = jevClientOverride(env) ?? jevClientEnvValue(jevClientPreference);
  return {
    TYPESAFE_API_KEY: typesafeKey ?? undefined,
    ...(client === undefined ? {} : { JEVC_JEV_CLIENT: client }),
    TYPESAFE_BASE_URL: env["TYPESAFE_BASE_URL"],
    TYPESAFE_DEFAULT_MODEL: env["TYPESAFE_DEFAULT_MODEL"],
  };
}
