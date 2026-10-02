import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { componentId, componentOf } from "../test-support/overview-builder.js";
import { componentIdForPath } from "./component-path.js";

const server = componentOf({ rootPath: "src/server", files: ["src/server/app.ts", "src/server/index.ts"] });
const serverRoutes = componentOf({ rootPath: "src/server/routes", files: ["src/server/routes/limits.ts"] });
const tests = componentOf({ rootPath: "tests", files: ["tests/rate-limit.test.ts", "src/server/app.test.ts"], role: "tests" });
const root = componentOf({ rootPath: ".", files: ["package.json"], name: "config", role: "config" });
const lib = componentOf({ rootPath: "lib", files: ["lib/a.ts"] });

describe("componentIdForPath (spec §5.2, ruling R6)", () => {
  it("prefers the component that lists the file over a path prefix", () => {
    // Rule 4: a test file joins the component it tests, which may sit outside its directory.
    expect(componentIdForPath([server, tests], "src/server/app.test.ts")).toBe(tests.id);
  });

  it("picks the longest root that is a whole-segment prefix", () => {
    expect(componentIdForPath([server, serverRoutes], "src/server/routes/new.ts")).toBe(serverRoutes.id);
    expect(componentIdForPath([server, serverRoutes], "src/server/new.ts")).toBe(server.id);
    expect(componentIdForPath([server], "src/server2/x.ts")).toBeNull();
  });

  it("falls back to the repo-root component and returns null without one", () => {
    expect(componentIdForPath([server, root], "scripts/build.mjs")).toBe(root.id);
    expect(componentIdForPath([server], "scripts/build.mjs")).toBeNull();
    expect(componentIdForPath([], "src/server/app.ts")).toBeNull();
  });

  it("returns a component that lists the path or whose root contains it", () => {
    const pool = ["src/server/app.ts", "src/server/routes/limits.ts", "src/server/app.test.ts", "tests/x.test.ts", "lib/a.ts", "package.json"];
    const components = [server, serverRoutes, tests, root, lib];
    fc.assert(
      fc.property(fc.subarray(components, { minLength: 0 }), fc.constantFrom(...pool), (chosen, path) => {
        const id = componentIdForPath(chosen, path);
        const owns = (c: (typeof components)[number]): boolean => c.files.includes(path) || c.rootPath === "." || path.startsWith(`${c.rootPath}/`);
        expect(id === null).toBe(!chosen.some(owns));
        const component = chosen.find((c) => c.id === id);
        expect(id === null || component !== undefined).toBe(true);
        const listed = chosen.some((c) => c.files.includes(path));
        expect(component === undefined || (listed ? component.files.includes(path) : owns(component))).toBe(true);
      }),
    );
  });

  it("names components by the spec id formula", () => {
    expect(server.id).toBe(componentId("src/server"));
    expect(server.id).toMatch(/^cmp_[0-9a-f]{12}$/);
  });
});
