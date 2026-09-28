import { describe, expect, it } from "vitest";

import { GitHunkDiffSchema } from "@jevcode/contracts";
import { diffHash } from "@jevcode/evidence-engine";

import {
  DIFF_TEXT_CAP_BYTES,
  capDiffText,
  isSecretPath,
  prepareDiffForStorage,
  redactEvidenceFact,
  redactText,
} from "./redactor.js";

const FILE_HEADER = [
  "diff --git a/src/big.ts b/src/big.ts",
  "--- a/src/big.ts",
  "+++ b/src/big.ts",
  "",
].join("\n");

function addedHunk(start: number, lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, index) => `+export const line${start + index} = "${"x".repeat(32)}";\n`,
  ).join("");
  return `@@ -${start},0 +${start},${lines} @@\n${body}`;
}

describe("redactText", () => {
  it("redacts AWS access keys", () => {
    const result = redactText("key=AKIAIOSFODNN7EXAMPLE rest");
    expect(result.text).toContain("[REDACTED:aws_key]");
    expect(result.count).toBe(1);
  });

  it("redacts JWTs", () => {
    const result = redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEFghiJkLmnOPqrsTUVwxyz");
    expect(result.text).toContain("[REDACTED:jwt]");
    expect(result.count).toBe(1);
  });

  it("redacts PEM private keys", () => {
    const text = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const result = redactText(text);
    expect(result.text).toContain("[REDACTED:private_key]");
    expect(result.text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7");
  });

  it("redacts password= and token= assignments", () => {
    const result = redactText("curl -u admin --password=hunter2 --token=abc123 x");
    expect(result.text).toContain("password=[REDACTED:password]");
    expect(result.text).toContain("token=[REDACTED:token]");
    expect(result.text).not.toContain("hunter2");
    expect(result.text).not.toContain("abc123");
  });

  it("redacts .env-style KEY=VALUE lines", () => {
    const result = redactText("STRIPE_SECRET_KEY=sk_live_1234\nDB_PASSWORD=opensesame");
    expect(result.text).toContain("STRIPE_SECRET_KEY=[REDACTED:env_value]");
    expect(result.text).toContain("DB_PASSWORD=[REDACTED:env_value]");
    expect(result.text).not.toContain("sk_live_1234");
    expect(result.text).not.toContain("opensesame");
  });

  it("redacts a prefixed env line inside a diff and keeps the prefix", () => {
    expect(redactText("+STRIPE_KEY=sk_live_abc")).toEqual({
      text: "+STRIPE_KEY=[REDACTED:env_value]",
      count: 1,
    });
    const result = redactText("-DB_PASSWORD=old\n DB_PASSWORD=same\n+PORT=3000");
    expect(result.text).toBe(
      "-DB_PASSWORD=[REDACTED:env_value]\n DB_PASSWORD=[REDACTED:env_value]\n+PORT=3000",
    );
    expect(result.count).toBe(2);
  });

  it("counts multiple redactions and leaves benign text alone", () => {
    const result = redactText("plain command line, no secrets");
    expect(result).toEqual({ text: "plain command line, no secrets", count: 0 });
  });
});

describe("redactEvidenceFact", () => {
  it("redacts test failure messages", () => {
    const { fact, count } = redactEvidenceFact({
      type: "test_result",
      repoId: "r",
      sessionId: "s",
      runner: "vitest",
      command: "pnpm test",
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [
        {
          file: "auth.test.ts",
          testName: "login",
          message: "auth failed with token=deadbeef",
        },
      ],
      ts: "t",
    });
    expect(count).toBe(1);
    if (fact.type === "test_result") {
      expect(fact.failures[0]?.message).toContain("[REDACTED:token]");
    }
  });

  it("redacts command_executed command lines", () => {
    const { fact, count } = redactEvidenceFact({
      type: "command_executed",
      repoId: "r",
      sessionId: "s",
      command: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.a.b' x",
      exitCode: 0,
      isDestructive: false,
      ts: "t",
    });
    expect(count).toBe(1);
    if (fact.type === "command_executed") {
      expect(fact.command).toContain("[REDACTED:jwt]");
    }
  });
});

describe("isSecretPath", () => {
  it("matches secret files by basename", () => {
    for (const file of [
      ".env",
      ".env.local",
      "config/.env.production",
      "certs/server.pem",
      "deploy/app.key",
      "home/.ssh/id_rsa",
      "id_rsa.pub", // R3's id_rsa* keeps the public half too
      "home/.ssh/id_ed25519",
      "home/.ssh/id_ed25519_work",
      "id_ecdsa",
      "id_dsa",
      "certs/client.p12",
      "certs/client.PFX",
      "android/release.jks",
      "android/app.keystore",
      ".npmrc",
      "home/.netrc",
      ".pgpass",
    ]) {
      expect(isSecretPath(file), file).toBe(true);
    }
    for (const file of [
      "src/env.ts",
      "src/keyboard.ts",
      "docs/pem-notes.md",
      "src/.environment/readme.md",
      "home/.ssh/id_ed25519.pub",
      "id_ecdsa.pub",
      "id_dsa.pub",
      "home/.ssh/id_ed25519-cert.pub",
      "src/keystore.ts",
      "docs/npmrc.md",
      "src/.npmrc.ts",
    ]) {
      expect(isSecretPath(file), file).toBe(false);
    }
  });
});

describe("capDiffText", () => {
  it("returns a diff under the cap unchanged", () => {
    const diff = FILE_HEADER + addedHunk(1, 3);
    expect(capDiffText(diff)).toEqual({ text: diff, truncated: false });
  });

  it("cuts a 40 KiB two-hunk diff before the second @@ header", () => {
    const first = addedHunk(1, 345);
    const second = addedHunk(1000, 345);
    const diff = FILE_HEADER + first + second;
    expect(Buffer.byteLength(diff)).toBeGreaterThan(40 * 1024);
    expect(Buffer.byteLength(FILE_HEADER + first)).toBeLessThan(DIFF_TEXT_CAP_BYTES);

    const capped = capDiffText(diff);
    expect(capped).toEqual({ text: FILE_HEADER + first, truncated: true });
  });

  it("keeps the header and whole lines of a first hunk larger than the cap", () => {
    const diff = FILE_HEADER + addedHunk(1, 1000);
    const capped = capDiffText(diff);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(DIFF_TEXT_CAP_BYTES);
    expect(capped.text.startsWith(FILE_HEADER + "@@ -1,0 +1,1000 @@\n")).toBe(true);
    expect(capped.text.endsWith("\n")).toBe(true);
    expect(diff.startsWith(capped.text)).toBe(true);
  });
});

describe("prepareDiffForStorage", () => {
  const raw = [
    "diff --git a/.env.local b/.env.local",
    "--- a/.env.local",
    "+++ b/.env.local",
    "@@ -1 +1 @@",
    "-STRIPE_KEY=sk_live_old",
    "+STRIPE_KEY=sk_live_abc",
    "",
  ].join("\n");

  it("withholds a secret path and stores no text", () => {
    const diff = prepareDiffForStorage(".env.local", raw);
    expect(diff).toEqual({
      hash: diffHash(raw),
      bytes: Buffer.byteLength(raw),
      truncated: false,
      redactions: 0,
      withheld: "secret_path",
    });
    expect(GitHunkDiffSchema.safeParse(diff).success).toBe(true);
  });

  it("redacts every line after its diff prefix and hashes the raw diff", () => {
    const diff = prepareDiffForStorage("src/config.ts", raw);
    expect(diff.hash).toBe(diffHash(raw));
    expect(diff.redactions).toBe(2);
    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain("+STRIPE_KEY=[REDACTED:env_value]");
    expect(diff.text).toContain("-STRIPE_KEY=[REDACTED:env_value]");
    expect(diff.text).not.toContain("sk_live");
    expect(GitHunkDiffSchema.safeParse(diff).success).toBe(true);
  });

  it("withholds an id_ed25519 private key and stores its .pub diff", () => {
    const key = [
      "diff --git a/deploy/id_ed25519 b/deploy/id_ed25519",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/deploy/id_ed25519",
      "@@ -0,0 +1,3 @@",
      "+-----BEGIN OPENSSH PRIVATE KEY-----",
      "+b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      "+-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n");
    expect(prepareDiffForStorage("deploy/id_ed25519", key)).toEqual({
      hash: diffHash(key),
      bytes: Buffer.byteLength(key),
      truncated: false,
      redactions: 0,
      withheld: "secret_path",
    });

    const pub = [
      "diff --git a/deploy/id_ed25519.pub b/deploy/id_ed25519.pub",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/deploy/id_ed25519.pub",
      "@@ -0,0 +1 @@",
      "+ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtestkeytestkeytestkeytestkeytestkeytestkey deploy@example.com",
      "",
    ].join("\n");
    expect(prepareDiffForStorage("deploy/id_ed25519.pub", pub)).toEqual({
      hash: diffHash(pub),
      bytes: Buffer.byteLength(pub),
      text: pub,
      truncated: false,
      redactions: 0,
    });
  });

  it("replaces a private key inside a source file with one counted line", () => {
    const withKey = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,2 +1,7 @@",
      ' export const issuer = "https://auth.example.com";',
      "+export const signingKey = `",
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+MIIEowIBAAKCAQEAtestkeytestkeytestkeytestkeytestkeytestkeytest01",
      "+testkeytestkeytestkeytestkeytestkeytestkeytestkeytestkeytest02==",
      "+-----END RSA PRIVATE KEY-----`;",
      ' export const audience = "jevcode";',
      "",
    ].join("\n");
    expect(prepareDiffForStorage("src/config.ts", withKey)).toEqual({
      hash: diffHash(withKey),
      bytes: Buffer.byteLength(withKey),
      text: [
        "diff --git a/src/config.ts b/src/config.ts",
        "--- a/src/config.ts",
        "+++ b/src/config.ts",
        "@@ -1,2 +1,7 @@",
        ' export const issuer = "https://auth.example.com";',
        "+export const signingKey = `",
        "+[REDACTED:private_key]",
        ' export const audience = "jevcode";',
        "",
      ].join("\n"),
      truncated: false,
      redactions: 1,
    });
  });

  it("redacts a private key block that its hunk cuts off before the END line", () => {
    const partial = [
      "diff --git a/deploy/key.txt b/deploy/key.txt",
      "--- a/deploy/key.txt",
      "+++ b/deploy/key.txt",
      "@@ -1,3 +1,3 @@",
      " -----BEGIN OPENSSH PRIVATE KEY-----",
      "-b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      "+QyNTUxOQAAACBtestkeytestkeytestkeytestkeytestkeytestkeytestkeyAAAAJgAAA",
      " AAAAC3NzaC1lZDI1NTE5AAAAIGtestkeytestkeytestkeytestkeytestkeytestkey",
      "@@ -9,2 +9,2 @@",
      "-# rotated 2026-01-01",
      "+# rotated 2026-09-28",
      " # owner: platform",
      "",
    ].join("\n");
    const diff = prepareDiffForStorage("deploy/key.txt", partial);
    expect(diff.redactions).toBe(1);
    expect(diff.text).toBe(
      [
        "diff --git a/deploy/key.txt b/deploy/key.txt",
        "--- a/deploy/key.txt",
        "+++ b/deploy/key.txt",
        "@@ -1,3 +1,3 @@",
        " [REDACTED:private_key]",
        "@@ -9,2 +9,2 @@",
        "-# rotated 2026-01-01",
        "+# rotated 2026-09-28",
        " # owner: platform",
        "",
      ].join("\n"),
    );
  });

  it("keeps public certificate and public key blocks", () => {
    const publicBlocks = [
      "diff --git a/src/tls.ts b/src/tls.ts",
      "--- a/src/tls.ts",
      "+++ b/src/tls.ts",
      "@@ -1 +1,8 @@",
      " export const caBundle = `",
      "+-----BEGIN CERTIFICATE-----",
      "+MIIBszCCAVmgAwIBAgIUtestcerttestcerttestcerttestcertMAoGCCqGSM49BAMC",
      "+-----END CERTIFICATE-----",
      "+-----BEGIN PUBLIC KEY-----",
      "+MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtestpubtestpubtestpubtestpubtest",
      "+-----END PUBLIC KEY-----",
      "+`;",
      "",
    ].join("\n");
    expect(prepareDiffForStorage("src/tls.ts", publicBlocks)).toEqual({
      hash: diffHash(publicBlocks),
      bytes: Buffer.byteLength(publicBlocks),
      text: publicBlocks,
      truncated: false,
      redactions: 0,
    });
  });
});
