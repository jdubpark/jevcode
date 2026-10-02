import { describe, expect, it } from "vitest";

import { overviewSnapshot } from "../test-support/overview-builder.js";
import { overviewStatusOf } from "./overview-status.js";

describe("overviewStatusOf (ruling R3)", () => {
  it("returns the row's status when it carries one", () => {
    const status = { scan: { state: "running" as const, scanned: 3_200, total: 9_800 }, narrator: "off" as const };
    expect(overviewStatusOf(overviewSnapshot({ components: [], status }))).toEqual(status);
  });

  it("reads a row without status as a finished scan, narrator pending while a purpose is missing", () => {
    const snapshot = overviewSnapshot({ components: [{ rootPath: "a", purpose: "Does a." }, { rootPath: "b" }], files: 12, totalFiles: 30 });
    expect(overviewStatusOf(snapshot)).toEqual({ scan: { state: "done", scanned: 12, total: 30 }, narrator: "pending" });
  });

  it("reads a row without status whose components all have a purpose as narrator ready", () => {
    const snapshot = overviewSnapshot({ components: [{ rootPath: "a", purpose: "Does a." }], files: 4 });
    expect(overviewStatusOf(snapshot)).toEqual({ scan: { state: "done", scanned: 4, total: 4 }, narrator: "ready" });
  });
});
