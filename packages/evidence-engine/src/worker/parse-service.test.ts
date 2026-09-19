import { describe, expect, it } from "vitest";

import { AnalysisPool } from "./parse-service.js";

const ECHO_WORKER = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (msg) => {
  setTimeout(() => {
    parentPort.postMessage({
      id: msg.id,
      filePath: msg.filePath,
      symbols: [{
        name: msg.source.trim(),
        kind: "function",
        signature: "echo",
        startLine: 1,
        endLine: 1,
      }],
    });
  }, 20);
});
`;

function echoWorkerUrl(): URL {
  const encoded = Buffer.from(ECHO_WORKER, "utf8").toString("base64");
  return new URL(`data:text/javascript;base64,${encoded}`);
}

const CRASH_WORKER = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (msg) => {
  if (msg.source === "crash") {
    throw new Error("simulated crash");
  }
  setTimeout(() => {
    parentPort.postMessage({
      id: msg.id,
      filePath: msg.filePath,
      symbols: [{
        name: msg.source.trim(),
        kind: "function",
        signature: "echo",
        startLine: 1,
        endLine: 1,
      }],
    });
  }, 20);
});
`;

function crashWorkerUrl(): URL {
  const encoded = Buffer.from(CRASH_WORKER, "utf8").toString("base64");
  return new URL(`data:text/javascript;base64,${encoded}`);
}

describe("AnalysisPool", () => {
  it("dispatches parses across workers and returns results", async () => {
    const pool = new AnalysisPool({ size: 2, workerUrl: echoWorkerUrl() });
    try {
      const results = await Promise.all([
        pool.parseFile("a.ts", "alpha"),
        pool.parseFile("b.ts", "beta"),
        pool.parseFile("c.ts", "gamma"),
      ]);
      expect(results.map((symbols) => symbols[0]?.name)).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
    } finally {
      await pool.dispose();
    }
  });

  it("surfaces worker parse errors", async () => {
    const failingWorker = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (msg) => {
  parentPort.postMessage({ id: msg.id, filePath: msg.filePath, error: "boom" });
});
`;
    const url = new URL(
      `data:text/javascript;base64,${Buffer.from(failingWorker, "utf8").toString("base64")}`,
    );
    const pool = new AnalysisPool({ size: 1, workerUrl: url });
    try {
      await expect(pool.parseFile("a.ts", "x")).rejects.toThrow("boom");
    } finally {
      await pool.dispose();
    }
  });

  it("rejects new parses after dispose", async () => {
    const pool = new AnalysisPool({ size: 1, workerUrl: echoWorkerUrl() });
    await pool.dispose();
    await expect(pool.parseFile("a.ts", "x")).rejects.toThrow("disposed");
  });
});

describe("AnalysisPool worker crashes", () => {
  it("rejects only the crashed worker's task and fulfills the others", async () => {
    const pool = new AnalysisPool({ size: 2, workerUrl: crashWorkerUrl() });
    try {
      const ok1 = pool.parseFile("a.ts", "alpha");
      const crash = pool.parseFile("b.ts", "crash");
      const ok2 = pool.parseFile("c.ts", "gamma");
      await expect(crash).rejects.toThrow(/crash/);
      const results = await Promise.all([ok1, ok2]);
      expect(results.map((symbols) => symbols[0]?.name)).toEqual([
        "alpha",
        "gamma",
      ]);
      expect(pool.queueDepth).toBe(0);
    } finally {
      await pool.dispose();
    }
  });

  it("respawns a replacement worker and keeps serving parses", async () => {
    const pool = new AnalysisPool({ size: 1, workerUrl: crashWorkerUrl() });
    try {
      await expect(pool.parseFile("a.ts", "crash")).rejects.toThrow(/crash/);
      const ok = await pool.parseFile("b.ts", "beta");
      expect(ok[0]?.name).toBe("beta");
      const again = await pool.parseFile("c.ts", "gamma");
      expect(again[0]?.name).toBe("gamma");
    } finally {
      await pool.dispose();
    }
  });
});

describe("AnalysisPool queue bounds and per-file merge", () => {
  it("bounds the queue, merges same-file parses with the latest source, and exposes depth", async () => {
    const pool = new AnalysisPool({ size: 1, maxQueueSize: 2, workerUrl: echoWorkerUrl() });
    try {
      const p1 = pool.parseFile("a.ts", "v1");
      const p2 = pool.parseFile("a.ts", "v2");
      const p3 = pool.parseFile("a.ts", "v3");
      const p4 = pool.parseFile("b.ts", "x");
      const p5 = pool.parseFile("c.ts", "y");
      await expect(p5).rejects.toThrow(/queue full/);
      expect(pool.queueDepth).toBe(2);
      expect(await p1).toEqual(expect.arrayContaining([expect.objectContaining({ name: "v1" })]));
      expect(await p2).toEqual(expect.arrayContaining([expect.objectContaining({ name: "v3" })]));
      expect(p2).toBe(p3);
      expect(await p4).toEqual(expect.arrayContaining([expect.objectContaining({ name: "x" })]));
      expect(pool.queueDepth).toBe(0);
    } finally {
      await pool.dispose();
    }
  });
});
