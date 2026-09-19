import type { z } from "zod";

import {
  mainToRendererPayloads,
  rendererToMainPayloads,
} from "@jevcode/contracts";

import { IpcError } from "./errors.js";
import { localFromMain, localToMain } from "./local-channels.js";

export const toMainRegistry = {
  ...rendererToMainPayloads,
  ...localToMain,
} as const;

export const fromMainRegistry = {
  ...mainToRendererPayloads,
  ...localFromMain,
} as const;

export type ToMainChannelName = keyof typeof toMainRegistry & string;

export type FromMainChannelName = keyof typeof fromMainRegistry & string;

export type ToMainPayload<C extends ToMainChannelName> = z.infer<
  (typeof toMainRegistry)[C]
>;

export type FromMainPayload<C extends FromMainChannelName> = z.infer<
  (typeof fromMainRegistry)[C]
>;

export function toMainChannelNames(): string[] {
  return Object.keys(toMainRegistry);
}

export function fromMainChannelNames(): string[] {
  return Object.keys(fromMainRegistry);
}

function parse(
  schema: z.ZodTypeAny | undefined,
  direction: string,
  channel: string,
  payload: unknown,
): unknown {
  if (schema === undefined) {
    throw new IpcError(
      "UNKNOWN_CHANNEL",
      `${direction} channel not registered: ${channel}`,
    );
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new IpcError(
      "INVALID_PAYLOAD",
      `${direction} ${channel}: ${result.error.message}`,
    );
  }
  return result.data;
}

export function parseToMain<C extends ToMainChannelName>(
  channel: C,
  payload: unknown,
): ToMainPayload<C>;
export function parseToMain(channel: string, payload: unknown): unknown;
export function parseToMain(channel: string, payload: unknown): unknown {
  return parse(toMainRegistry[channel as ToMainChannelName], "toMain", channel, payload);
}

export function parseFromMain<C extends FromMainChannelName>(
  channel: C,
  payload: unknown,
): FromMainPayload<C>;
export function parseFromMain(channel: string, payload: unknown): unknown;
export function parseFromMain(channel: string, payload: unknown): unknown {
  return parse(fromMainRegistry[channel as FromMainChannelName], "fromMain", channel, payload);
}
