import { pbkdf2Sync, randomBytes } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return pbkdf2Sync(password, salt, 100_000, 64, "sha512").toString("hex");
}

export function verifyPassword(hash: string, candidate: string): boolean {
  return hashPassword(candidate) === hash;
}

export interface Session {
  userId: number;
  token: string;
  expiresAt: Date;
}

export function createSession(userId: number): Session {
  return {
    userId,
    token: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
  };
}
