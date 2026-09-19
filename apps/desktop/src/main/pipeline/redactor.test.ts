import { describe, expect, it } from "vitest";

import { redactEvidenceFact, redactText } from "./redactor.js";

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
