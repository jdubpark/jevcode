import { randomBytes } from "node:crypto";

export interface Session {
  identityId: string;
  token: string;
  expiresAt: Date;
}

export function createSession(identityId: string): Session {
  return {
    identityId,
    token: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  };
}
