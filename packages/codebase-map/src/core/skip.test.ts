import { describe, expect, it } from "vitest";

import { isSkippedPath, normalizePath } from "./paths.js";

describe("isSkippedPath (spec §5.1, §10)", () => {
  it.each([
    ["node_modules/x/index.js", true],
    ["packages/a/dist/index.js", true],
    ["build/out.js", true],
    [".next/cache/a.js", true],
    ["coverage/lcov.info", true],
    ["vendor/lib.js", true],
    ["pnpm-lock.yaml", true],
    ["web/app.min.js", true],
    ["web/app.js.map", true],
    ["assets/logo.png", true],
    ["fonts/a.woff2", true],
    [".env", true],
    [".env.local", true],
    ["certs/server.pem", true],
    ["keys/id_rsa", true],
    ["config/api.key", true],
    [".npmrc", true],
    [".envrc", true],
    [".htpasswd", true],
    [".git-credentials", true],
    ["keys/AuthKey.p8", true],
    ["infra/prod.tfvars", true],
    ["gcp/service-account-prod.json", true],
    ["src/service-accounts.ts", false],
    [".env.example", false],
    ["src/env.ts", false],
    ["src/build.ts", false],
    ["src/keyboard.ts", false],
    ["docs/dist.md", false],
  ])("%s → %s", (path, expected) => {
    expect(isSkippedPath(path)).toBe(expected);
  });
});

describe("normalizePath", () => {
  it.each([
    ["./a/b", "a/b"],
    ["a/../b", "b"],
    ["a/./b/", "a/b"],
    [".", ""],
    ["../x", null],
    ["/etc/hosts", null],
  ])("%s → %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});
