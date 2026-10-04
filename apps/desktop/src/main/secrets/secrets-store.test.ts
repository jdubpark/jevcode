// apps/desktop/src/main/secrets/secrets-store.test.ts
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CANNOT_ENCRYPT_MESSAGE, INVALID_KEY_MESSAGE } from "../../shared/secrets.js";
import { createSecretsStore, SecretsError } from "./secrets-store.js";
import type { SecretCrypto } from "./secrets-store.js";

const SECRET = "sk-ant-api03-abcdefghijklmnop-1234";

function fakeCrypto(overrides: Partial<SecretCrypto> = {}): SecretCrypto {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${[...plain].reverse().join("")}`),
    decryptString: (cipher) => {
      const text = cipher.toString();
      if (!text.startsWith("enc:")) throw new Error("decrypt failed");
      return [...text.slice(4)].reverse().join("");
    },
    ...overrides,
  };
}

let dir: string;
let filePath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-secrets-"));
  filePath = path.join(dir, "secrets.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("secrets store", () => {
  it("reports no keys without a file", () => {
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env: {} });
    expect(store.view()).toEqual({
      canSave: true,
      fileUnreadable: false,
      keys: [
        { name: "ANTHROPIC_API_KEY", set: false, source: "none", last4: null, envAlsoSet: false, unreadable: false },
        { name: "TYPESAFE_API_KEY", set: false, source: "none", last4: null, envAlsoSet: false, unreadable: false },
      ],
    });
    expect(store.active("ANTHROPIC_API_KEY")).toBeNull();
  });

  it("saves a trimmed key encrypted, with mode 0600 and no plaintext on disk", () => {
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env: {} });
    const view = store.set("ANTHROPIC_API_KEY", `  ${SECRET}\n`);
    expect(view.keys[0]).toMatchObject({ set: true, source: "app", last4: "1234" });
    expect(store.active("ANTHROPIC_API_KEY")).toBe(SECRET);
    const text = readFileSync(filePath, "utf8");
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ version: 1, keys: { ANTHROPIC_API_KEY: expect.any(String) } });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
  });

  it("prefers the saved key over the environment and falls back after removal", () => {
    const env = { ANTHROPIC_API_KEY: "sk-env-key-9999" };
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env });
    expect(store.view().keys[0]).toMatchObject({ source: "env", last4: "9999", envAlsoSet: false });
    store.set("ANTHROPIC_API_KEY", SECRET);
    expect(store.view().keys[0]).toMatchObject({ source: "app", last4: "1234", envAlsoSet: true });
    expect(store.active("ANTHROPIC_API_KEY")).toBe(SECRET);
    store.remove("ANTHROPIC_API_KEY");
    expect(store.view().keys[0]).toMatchObject({ source: "env", last4: "9999" });
    expect(store.active("ANTHROPIC_API_KEY")).toBe("sk-env-key-9999");
  });

  it("ignores blank environment values and reads the TypeSafe alias in order", () => {
    expect(createSecretsStore({ filePath, crypto: fakeCrypto(), env: { ANTHROPIC_API_KEY: "   " } }).active("ANTHROPIC_API_KEY")).toBeNull();
    const both = createSecretsStore({ filePath, crypto: fakeCrypto(), env: { TYPESAFE_API_KEY: "ts-primary", JEV_API_KEY: "jev-alias" } });
    expect(both.active("TYPESAFE_API_KEY")).toBe("ts-primary");
    const alias = createSecretsStore({ filePath, crypto: fakeCrypto(), env: { JEV_API_KEY: "jev-alias" } });
    expect(alias.active("TYPESAFE_API_KEY")).toBe("jev-alias");
  });

  it("refuses to save when the OS cannot encrypt, and environment keys still work", () => {
    const store = createSecretsStore({ filePath, crypto: fakeCrypto({ isEncryptionAvailable: () => false }), env: { ANTHROPIC_API_KEY: "sk-env-key-9999" } });
    expect(store.view().canSave).toBe(false);
    expect(() => store.set("ANTHROPIC_API_KEY", SECRET)).toThrow(new SecretsError("CANNOT_ENCRYPT", CANNOT_ENCRYPT_MESSAGE));
    expect(store.active("ANTHROPIC_API_KEY")).toBe("sk-env-key-9999");
  });

  it.each(["", "   ", "sk ant", "x".repeat(513), "sk-\u0007-bell"])("refuses %j without repeating it", (value) => {
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env: {} });
    let error: unknown;
    try {
      store.set("ANTHROPIC_API_KEY", value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SecretsError);
    expect((error as SecretsError).code).toBe("INVALID_VALUE");
    expect((error as SecretsError).message).toBe(INVALID_KEY_MESSAGE);
  });

  it("reads a corrupt file as no saved keys and repairs it on the next save", () => {
    writeFileSync(filePath, "{not json");
    const logs: string[] = [];
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env: {}, log: (m) => logs.push(m) });
    expect(store.view()).toMatchObject({ fileUnreadable: true });
    expect(readFileSync(filePath, "utf8")).toBe("{not json");
    store.set("TYPESAFE_API_KEY", "ts-key-5678");
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ version: 1 });
    expect(store.view().fileUnreadable).toBe(false);
    expect(logs.join("\n")).not.toContain("ts-key-5678");
  });

  it("marks a key it cannot decrypt as unreadable and falls back to the environment (Review Focus 2)", () => {
    writeFileSync(filePath, JSON.stringify({ version: 1, keys: { ANTHROPIC_API_KEY: Buffer.from("garbage").toString("base64") } }));
    const logs: string[] = [];
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env: { ANTHROPIC_API_KEY: "sk-env-key-9999" }, log: (m) => logs.push(m) });
    expect(store.active("ANTHROPIC_API_KEY")).toBe("sk-env-key-9999");
    expect(store.view().keys[0]).toMatchObject({ source: "env", unreadable: true });
    expect(logs.some((line) => line.includes("could not be decrypted"))).toBe(true);
  });

  it("leaves the previous file and state unchanged when a save fails (Review Focus 3)", () => {
    const crypto = fakeCrypto();
    const store = createSecretsStore({ filePath, crypto, env: {} });
    store.set("ANTHROPIC_API_KEY", SECRET);
    const before = readFileSync(filePath);
    crypto.encryptString = () => {
      throw new Error("keychain locked");
    };
    expect(() => store.set("ANTHROPIC_API_KEY", "sk-new-value-0000")).toThrow("keychain locked");
    expect(readFileSync(filePath).equals(before)).toBe(true);
    expect(store.active("ANTHROPIC_API_KEY")).toBe(SECRET);
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
  });

  it("leaves the previous file and state unchanged when the disk write fails (Review Focus 3)", () => {
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env: {} });
    store.set("ANTHROPIC_API_KEY", SECRET);
    const before = readFileSync(filePath);
    chmodSync(dir, 0o500); // the temporary file cannot be created, like a full or read-only disk
    try {
      expect(() => store.set("ANTHROPIC_API_KEY", "sk-new-value-0000")).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(filePath).equals(before)).toBe(true);
    expect(store.active("ANTHROPIC_API_KEY")).toBe(SECRET);
  });

  it("reads saved keys back in a new store and notifies subscribers per change", () => {
    const first = createSecretsStore({ filePath, crypto: fakeCrypto(), env: {} });
    const seen: string[] = [];
    const off = first.subscribe((name) => seen.push(name));
    first.set("TYPESAFE_API_KEY", "ts-key-5678");
    first.remove("TYPESAFE_API_KEY");
    off();
    first.set("ANTHROPIC_API_KEY", SECRET);
    expect(seen).toEqual(["TYPESAFE_API_KEY", "TYPESAFE_API_KEY"]);
    const second = createSecretsStore({ filePath, crypto: fakeCrypto(), env: {} });
    expect(second.active("ANTHROPIC_API_KEY")).toBe(SECRET);
    expect(second.active("TYPESAFE_API_KEY")).toBeNull();
  });

  it("rejects a name outside the allowlist", () => {
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env: {} });
    expect(() => store.set("OPENAI_API_KEY" as never, SECRET)).toThrow(SecretsError);
  });

  it("lets a subscriber read the new value when it is notified", () => {
    const store = createSecretsStore({ filePath, crypto: fakeCrypto(), env: { ANTHROPIC_API_KEY: "sk-env-key-9999" } });
    const seen: (string | null)[] = [];
    store.subscribe((name) => seen.push(store.active(name)));
    store.set("ANTHROPIC_API_KEY", SECRET);
    store.remove("ANTHROPIC_API_KEY");
    expect(seen).toEqual([SECRET, "sk-env-key-9999"]);
  });
});
