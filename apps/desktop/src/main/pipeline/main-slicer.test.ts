import { describe, expect, it } from "vitest";

import { createMainSlicer, type MainSlicer } from "./main-slicer.js";

// Lane 07 PL-3 continuation: the pipeline's sync pass and the session explainer's fold share one slicer, so one
// event-loop turn never runs a full slice of each.

interface Step {
  task: string;
  turn: number;
  ms: number;
}

/** Counts event-loop turns: one setImmediate callback per turn, as the probes in docs/perf.md measure blocks. */
function turnCounter(): { readonly turn: number; stop(): void } {
  let turn = 0;
  let running = true;
  const tick = (): void => {
    turn += 1;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    get turn() {
      return turn;
    },
    stop() {
      running = false;
    },
  };
}

/** Work of known duration on a fake clock: each step advances it by stepMs. */
function cooperativeTask(
  slicer: MainSlicer,
  clock: { now: number },
  turns: { readonly turn: number },
  log: Step[],
  task: string,
  options: { steps: number; stepMs: number; yieldEvery?: number },
): Promise<void> {
  return (async () => {
    await slicer.yield();
    for (let index = 1; index <= options.steps; index += 1) {
      clock.now += options.stepMs;
      log.push({ task, turn: turns.turn, ms: options.stepMs });
      // A slice check, as pace() does; yieldEvery adds a voluntary yield, as the fold does at a page end.
      if (slicer.spent() || (options.yieldEvery !== undefined && index % options.yieldEvery === 0)) await slicer.yield();
    }
  })();
}

describe("main slicer", () => {
  it("never lets two cooperating tasks run past the budget together in one turn, and starves neither", async () => {
    const clock = { now: 0 };
    const slicer = createMainSlicer({ budgetMs: 20, now: () => clock.now });
    const log: Step[] = [];
    const counter = turnCounter();
    // "fold" yields on its own every 3 steps (a page end), so turns hold work of both tasks.
    await Promise.all([
      cooperativeTask(slicer, clock, counter, log, "pass", { steps: 60, stepMs: 3 }),
      cooperativeTask(slicer, clock, counter, log, "fold", { steps: 40, stepMs: 4, yieldEvery: 3 }),
    ]);
    counter.stop();
    expect(log.filter((step) => step.task === "pass")).toHaveLength(60);
    expect(log.filter((step) => step.task === "fold")).toHaveLength(40);

    const turns = new Map<number, { ms: number; tasks: Set<string> }>();
    for (const step of log) {
      const turn = turns.get(step.turn) ?? { ms: 0, tasks: new Set<string>() };
      turn.ms += step.ms;
      turn.tasks.add(step.task);
      turns.set(step.turn, turn);
    }
    // A turn ends at the first slice check after its budget, whichever task did the work: never more than the
    // budget plus one step, never two full slices.
    for (const [turn, { ms }] of turns) expect(ms, `event-loop turn ${turn}`).toBeLessThanOrEqual(20 + 4);
    expect([...turns.values()].some((turn) => turn.tasks.size === 2)).toBe(true);

    // Neither starves: while both have work left, each runs at least every other turn.
    const lastTurn = (task: string): number => Math.max(...log.filter((step) => step.task === task).map((step) => step.turn));
    const bothActive = Math.min(lastTurn("pass"), lastTurn("fold"));
    for (const task of ["pass", "fold"]) {
      const ran = new Set(log.filter((step) => step.task === task).map((step) => step.turn));
      const first = Math.min(...ran);
      for (let turn = first; turn < bothActive; turn += 1) {
        expect({ task, turn, ranWithinTwo: ran.has(turn) || ran.has(turn + 1) }).toEqual({ task, turn, ranWithinTwo: true });
      }
    }
  });

  it("does not wedge when a resumed task finishes or throws without yielding back: the next one runs a turn later", async () => {
    const slicer = createMainSlicer();
    const counter = turnCounter();
    const ran: { task: string; turn: number }[] = [];
    const finishes = (async () => {
      await slicer.yield();
      ran.push({ task: "finishes", turn: counter.turn });
    })();
    const throws = (async () => {
      await slicer.yield();
      ran.push({ task: "throws", turn: counter.turn });
      throw new Error("pass failed");
    })();
    const yieldsBack = (async () => {
      await slicer.yield();
      ran.push({ task: "yields back", turn: counter.turn });
      await slicer.yield();
      ran.push({ task: "yields back, resumed", turn: counter.turn });
    })();
    const wedged = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the slicer wedged")), 2_000));
    await Promise.race([Promise.all([finishes, throws.catch(() => undefined), yieldsBack]), wedged]);
    counter.stop();
    await expect(throws).rejects.toThrow("pass failed");
    expect(ran.map((entry) => entry.task)).toEqual(["finishes", "throws", "yields back", "yields back, resumed"]);
    // Each next task runs one event-loop turn after the previous one, whether that one finished, threw or yielded.
    const turns = ran.map((entry) => entry.turn);
    expect(turns.slice(1).map((turn, index) => turn - (turns[index] ?? 0))).toEqual([1, 1, 1]);
  });

  it("resumes a yield in a later event-loop turn, in queue order", async () => {
    const slicer = createMainSlicer();
    const order: string[] = [];
    const first = slicer.yield().then(() => order.push("first"));
    const second = slicer.yield().then(() => order.push("second"));
    // Not in this turn's microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);

    // A yield made during a turn waits for the next turn, even with budget left.
    const before = slicer.turns;
    await slicer.yield();
    const resumedIn = slicer.turns;
    await slicer.yield();
    expect(resumedIn).toBe(before + 1);
    expect(slicer.turns).toBe(resumedIn + 1);
  });

  it("counts work outside a turn as spent, so a task started by a timer or IPC yields at its first check", () => {
    const slicer = createMainSlicer();
    expect(slicer.spent()).toBe(true);
  });
});
