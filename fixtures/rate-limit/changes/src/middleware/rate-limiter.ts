import type { NextFunction, Request, Response } from "express";

import { getRedis } from "../redis/client";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
  failOpen: boolean;
}

export function rateLimiter(options: RateLimitOptions) {
  const windowKey = Math.floor(Date.now() / options.windowMs);

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = `${options.keyPrefix ?? "rl"}:${req.ip}:${windowKey}`;
    try {
      const redis = getRedis();
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.pexpire(key, options.windowMs);
      }
      if (count > options.max) {
        res.status(429).json({ error: "rate limit exceeded" });
        return;
      }
      next();
    } catch (err) {
      if (options.failOpen) {
        next();
        return;
      }
      res.status(503).json({ error: "rate limiter unavailable" });
    }
  };
}
