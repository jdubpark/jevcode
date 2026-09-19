import express from "express";

import { rateLimiter } from "../middleware/rate-limiter";

export function createApp() {
  const app = express();

  app.use(
    rateLimiter({
      windowMs: 60_000,
      max: 100,
      keyPrefix: "public-api",
      failOpen: true,
    }),
  );

  app.get("/items", (_req, res) => {
    res.json({ items: ["a", "b", "c"] });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
