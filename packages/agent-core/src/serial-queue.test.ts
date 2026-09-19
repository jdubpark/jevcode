import { describe, expect, it } from "vitest";

import { SerialQueue } from "./serial-queue.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => resolve());

describe("SerialQueue", () => {
  it("runs tasks strictly one at a time", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const first = deferred();
    const second = deferred();

    const p1 = queue.run(async () => {
      order.push("first:start");
      await first.promise;
      order.push("first:end");
    });
    const p2 = queue.run(async () => {
      order.push("second:start");
      await second.promise;
      order.push("second:end");
    });

    await tick();
    expect(order).toEqual(["first:start"]);

    first.resolve();
    await p1;
    await tick();
    expect(order).toEqual(["first:start", "first:end", "second:start"]);

    second.resolve();
    await p2;
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("propagates return values in order", async () => {
    const queue = new SerialQueue();
    const results: string[] = [];
    const first = deferred();
    const p1 = queue.run(async () => {
      await first.promise;
      return "one";
    });
    const p2 = queue.run(async () => "two");
    first.resolve();
    results.push(await p1, await p2);
    expect(results).toEqual(["one", "two"]);
  });

  it("keeps running after a task rejects", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const boom = queue.run(async () => {
      order.push("boom");
      throw new Error("task failure");
    });
    const after = queue.run(async () => {
      order.push("after");
      return "ok";
    });
    await expect(boom).rejects.toThrow("task failure");
    expect(await after).toBe("ok");
    expect(order).toEqual(["boom", "after"]);
  });

  it("supports synchronous tasks", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    await Promise.all([
      queue.run(() => {
        order.push("a");
      }),
      queue.run(() => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a", "b"]);
  });
});
