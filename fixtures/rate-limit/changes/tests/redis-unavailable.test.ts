import { describe, expect, it, vi } from "vitest";

import { rateLimiter } from "../src/middleware/rate-limiter";

vi.mock("../src/redis/client", () => ({
  getRedis: () => {
    throw new Error("ECONNREFUSED");
  },
}));

const req = { ip: "10.0.0.1" } as never;
const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as never;
const next = vi.fn();

describe("rateLimiter with redis unavailable", () => {
  it("fails open by default", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: true })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("fails closed when configured", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: false })(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns a helpful error body when closed", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: false })(req, res, next);
    expect(res.json).toHaveBeenCalledWith({ error: "rate limiter unavailable" });
  });
});
