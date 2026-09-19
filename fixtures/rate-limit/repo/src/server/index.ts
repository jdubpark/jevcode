import express from "express";

import { config } from "../config";

const app = express();

app.get("/items", (_req, res) => {
  res.json({ items: ["a", "b", "c"] });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});

export default app;
