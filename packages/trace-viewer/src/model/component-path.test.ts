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

  it('falls back to the repo-root component only for a root-level path: "." holds root-level files only (lane 06 fix I-3)', () => {
    expect(componentIdForPath([server, root], "README.md")).toBe(root.id);
    // Lane 04 groups a nested file by its directory, so an unclaimed nested path never belongs to ".".
    expect(componentIdForPath([server, root], "scripts/build.mjs")).toBeNull();
    expect(componentIdForPath([server, root], "config/app.json")).toBeNull();
    expect(componentIdForPath([server], "README.md")).toBeNull();
    expect(componentIdForPath([], "src/server/app.ts")).toBeNull();
  });

  it("returns a component that lists the path or whose root contains it, and the root component only for a root-level path", () => {
    const pool = ["src/server/app.ts", "src/server/routes/limits.ts", "src/server/app.test.ts", "tests/x.test.ts", "lib/a.ts", "package.json", "README.md", "scripts/build.mjs"];
    const components = [server, serverRoutes, tests, root, lib];
    fc.assert(
      fc.property(fc.subarray(components, { minLength: 0 }), fc.constantFrom(...pool), (chosen, path) => {
        const id = componentIdForPath(chosen, path);
        const owns = (c: (typeof components)[number]): boolean =>
          c.files.includes(path) || (c.rootPath === "." && !path.includes("/")) || path.startsWith(`${c.rootPath}/`);
        expect(id === null).toBe(!chosen.some(owns));
        const component = chosen.find((c) => c.id === id);
        expect(id === null || component !== undefined).toBe(true);
        const listed = chosen.some((c) => c.files.includes(path));
        expect(component === undefined || (listed ? component.files.includes(path) : owns(component))).toBe(true);
      }),
    );
  });

  it("takes repo-relative paths only: an absolute path, a ./ path and an empty path match nothing by root or list", () => {
    expect(componentIdForPath([server], "/repo/src/server/app.ts")).toBeNull();
    expect(componentIdForPath([server], "./src/server/app.ts")).toBeNull();
    expect(componentIdForPath([server], "")).toBeNull();
    // They are not normalized: a "./" path is nested, so not even the repo-root component catches it.
    expect(componentIdForPath([server, root], "./src/server/app.ts")).toBeNull();
  });

  it('sends an unclaimed nested path to the "(other)" component, which never matches by prefix (lane 06 fix I-3)', () => {
    const other = componentOf({ rootPath: "(other)", name: "(other)", files: ["misc/a.ts"] });
    expect(componentIdForPath([server, other], "misc/a.ts")).toBe(other.id);
    // A file of a grouped directory past the 400-file list, or a directory created after the scan.
    expect(componentIdForPath([server, other], "misc/b.ts")).toBe(other.id);
    expect(componentIdForPath([server, other, root], "misc/b.ts")).toBe(other.id);
    expect(componentIdForPath([server, other, root], "(other)/new.ts")).toBe(other.id);
    // A claimed path keeps its component; a root-level path goes to "." first, else to "(other)" (where lane 04 puts a "." past the cap).
    expect(componentIdForPath([server, other], "src/server/new.ts")).toBe(server.id);
    expect(componentIdForPath([server, other, root], "README.md")).toBe(root.id);
    expect(componentIdForPath([server, other], "README.md")).toBe(other.id);
  });

  it("names components by the spec id formula", () => {
    expect(server.id).toBe(componentId("src/server"));
    expect(server.id).toMatch(/^cmp_[0-9a-f]{12}$/);
  });
});
