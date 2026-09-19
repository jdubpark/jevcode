import { describe, expect, it, vi } from "vitest";

import { rateLimiter } from "../src/middleware/rate-limiter";

const redis = {
  incr: vi.fn().mockResolvedValue(1),
  pexpire: vi.fn().mockResolvedValue(1),
};

vi.mock("../src/redis/client", () => ({
  getRedis: () => redis,
}));

const req = { ip: "10.0.0.1" } as never;
const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as never;
const next = vi.fn();

describe("rateLimiter", () => {
  it("allows requests at or under the max", async () => {
    const middleware = rateLimiter({ windowMs: 60_000, max: 100, failOpen: true });
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("blocks requests above the max with 429", async () => {
    redis.incr.mockResolvedValueOnce(101);
    const middleware = rateLimiter({ windowMs: 60_000, max: 100, failOpen: true });
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("sets an expiry on the first request in a window", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: true })(req, res, next);
    expect(redis.pexpire).toHaveBeenCalled();
  });

  it("continues to the next middleware when under the limit", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: true })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("prepends the configured key prefix", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, keyPrefix: "api", failOpen: true })(req, res, next);
    expect(redis.incr).toHaveBeenCalledWith(expect.stringMatching(/^api:/));
  });

  it("counts requests from different ips independently", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: true })({ ip: "10.0.0.2" } as never, res, next);
    expect(redis.incr).toHaveBeenCalled();
  });

  it("responds 503 when redis fails and failOpen is false", async () => {
    vi.mocked(redis.incr).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const middleware = rateLimiter({ windowMs: 60_000, max: 100, failOpen: false });
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("continues when redis fails and failOpen is true", async () => {
    vi.mocked(redis.incr).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const middleware = rateLimiter({ windowMs: 60_000, max: 100, failOpen: true });
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("uses separate counters per key", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: true })(req, res, next);
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: true })(req, res, next);
    expect(redis.incr).toHaveBeenCalledTimes(2);
  });

  it("resets the counter after the window elapses", async () => {
    vi.useFakeTimers();
    const middleware = rateLimiter({ windowMs: 60_000, max: 100, failOpen: true });
    await middleware(req, res, next);
    vi.advanceTimersByTime(60_000);
    await middleware(req, res, next);
    vi.useRealTimers();
    expect(redis.incr).toHaveBeenCalled();
  });

  it("does not mutate the response on success", async () => {
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: true })(req, res, next);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("allows the configured maximum without blocking", async () => {
    redis.incr.mockResolvedValueOnce(100);
    await rateLimiter({ windowMs: 60_000, max: 100, failOpen: true })(req, res, next);
    expect(res.status).not.toHaveBeenCalled();
  });
});
