# Settings Page and API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings page in the desktop main window where the person adds, replaces, removes and tests API keys (stored encrypted through the OS keychain) and turns the narrator, agent backend, Jev decisions client and Codex options on or off, with no restart and no file edits.

**Architecture:** A secrets store in desktop main encrypts saved keys with Electron `safeStorage` into `<userData>/secrets.json` and resolves each key's active value (saved over environment). IPC exposes only key statuses (source and last four characters), never values. The narrator switch reads the active Anthropic key and rebuilds its client when it changes; the runtime builds each session's Jev client and agent backend from stored preferences, with environment variables still winning. A renderer Settings page replaces the sidebar's Agent settings panel.

**Tech Stack:** TypeScript (strict, NodeNext), Electron 33 (`safeStorage`, `app.getPath`), React 19, zod 3 (desktop IPC schemas), `@anthropic-ai/sdk` 0.131 (key check), vitest + @testing-library/react (jsdom), better-sqlite3 preferences table (existing).

**Spec:** `docs/superpowers/specs/2026-10-04-settings-and-api-keys-design.md`

## Global Constraints

- Allowed key names: `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`. The TypeSafe key's environment fallback order is `TYPESAFE_API_KEY`, then `JEV_API_KEY`.
- Saved keys: Electron `safeStorage`, file `<userData>/secrets.json`, shape `{ version: 1, keys: { NAME: base64Ciphertext } }`, file mode 0600, written atomically (temporary file, then rename). No plaintext fallback: when `safeStorage.isEncryptionAvailable()` is false, saving is refused with "This system cannot encrypt saved keys; set the key in the environment instead."
- Active key: the saved value if present, else the environment value (`process.env`, which already includes `.env`), else none. Blank or whitespace-only values count as none.
- A key value never crosses IPC, is never logged, and never appears in an error message. The window sees only `{ name, set, source, last4, envAlsoSet, unreadable }`.
- Refinement of the spec's IPC table: `secrets:status|set|remove` reply with a `SecretsView` (`{ canSave, fileUnreadable, keys: KeyStatus[] }`) instead of a bare `KeyStatus[]`, and `KeyStatus` adds `unreadable`. The page needs `canSave` to disable saving and `unreadable` / `fileUnreadable` to show "A saved key could not be read; save it again".
- Smoke runs (`JEVCODE_SMOKE=1`) never touch the OS keychain: main points the store at `JEVCODE_SECRETS_FILE` and passes a crypto stub that reports encryption as available but refuses to encrypt or decrypt, so a keychain prompt cannot block the main thread mid-smoke.
- Value validation: trimmed, non-empty, at most 512 characters, no whitespace or control characters.
- Key test (Anthropic only): `GET https://api.anthropic.com/v1/models` through the SDK with the pinned base URL, a 10 s timeout and no retries; button-triggered only; results `ok`, `unauthorized`, `unreachable`, `error` (with HTTP status when known).
- Narrator key changes apply at once; the TypeSafe key, the Jev client choice and the agent backend apply to the next session, and the page says "Applies to new sessions."
- Environment overrides win over stored toggles: `JEVC_AGENT` (agent backend), `JEVC_JEV_CLIENT` (Jev client, `degrade` = offline), `JEVCODE_NARRATOR=off` (narrator). An overridden control is disabled with "Set by NAME=value (environment)."
- The page opens from the sidebar's "Settings" row or Cmd+, (macOS) / Ctrl+, (elsewhere); Back or Esc returns to the session view exactly as it was (the workspace stays mounted).
- Style: the app's light, restrained look (few borders, icon plus short text), `--tv-*` tokens; every host CSS selector carries a class or id (the host style guard in `apps/desktop/src/renderer/styles-scope.test.tsx`).
- Repo rules (`~/Projects/jevcode/.superpowers/orchestration/ce-implementer-rules.md`): never `git stash`; `git add <paths>` only; commit as Jongwon Park <contact@parkjongwon.com> with no trailers; wrap vitest as `perl -e 'alarm 150; exec @ARGV' pnpm --filter <pkg> exec vitest run <file>`; native modules only through `pnpm --filter jevcode-desktop run rebuild` / `run rebuild:node`; Electron runs set `ANTHROPIC_API_KEY=""` and `JEVCODE_NARRATOR=off`; tests never touch the network.

## Review Focus

1. A key pasted with surrounding spaces or a trailing newline is saved trimmed; a key with an inner space is refused with a message that does not repeat it (Task 1 store test, Task 6 page test).
2. The keychain refuses to decrypt a saved key (keychain reset, item denied): the app still starts, that key shows "A saved key could not be read; save it again", and the narrator falls back to an environment key if there is one (Task 1 store test, Task 4 switch test).
3. A failure while saving (encryption throws, disk full) leaves the previous `secrets.json` byte-identical and the in-memory state unchanged (Task 1 store test).
4. Removing a saved Anthropic key while the environment has one flips the source to "From environment" and keeps the narrator on with the environment key (Task 4 test).
5. A trace window, which shares the preload, cannot read, set, remove or test keys, and never receives `secrets:updated` (Task 3 allowlist test).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `apps/desktop/src/shared/secrets.ts` (new) | Key names, statuses, views, value validation, environment fallback names. Shared by main and renderer; no Node imports | 1 |
| `apps/desktop/src/main/secrets/secrets-store.ts` (new) + test | Encrypted file, active-value resolution, statuses, change subscription | 1 |
| `packages/jev-router/src/narrator/anthropic-transport.ts` + test | `checkAnthropicKey` on the same hardened SDK client (already re-exported through `narrator/index.ts` and the package root by `export *`) | 2 |
| `apps/desktop/src/shared/local-channels.ts`, `shared/api.ts`, `shared/errors.ts`, `main/ipc.ts` + tests, `main/trace-allowlist.test.ts`, `renderer/test-support/fake-bridge.ts` | `secrets:*` channels, renderer API, handlers | 3 |
| `apps/desktop/src/main/pipeline/narrator-switch.ts` + test, `main/index.ts` | Narrator reads the active key and re-keys; secrets store wiring | 4 |
| `apps/desktop/src/shared/prefs.ts` + test, `shared/local-channels.ts`, `main/ipc.ts`, `main/pipeline/agent-mode.ts` (new) + test, `main/pipeline/types.ts`, `main/pipeline/pipeline-runtime.ts` + test, `main/index.ts` | Agent backend and Jev client preferences, environment overrides, per-session wiring | 5 |
| `apps/desktop/src/renderer/settings/{SettingsPage,KeysSection,FeaturesSection}.tsx`, `settings/settings-format.ts`, tests; `renderer/App.tsx`, `renderer/components/glyph.tsx`, `renderer/components/narrator-format.ts` + test, `renderer/styles.css`; delete `renderer/components/AgentSettings.tsx` and `agent-settings.test.tsx` | The page and its route | 6 |
| `apps/desktop/src/main/smoke-workspace.ts` + test, `apps/desktop/scripts/smoke-workspace.mjs`, `docs/SPEC.md` | Electron screenshot, smoke hygiene, product spec | 7 |

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 (each consumes the previous names). Tasks 1 and 2 are independent and may run in either order.

---

### Task 1: Shared key types and the secrets store

**Files:**
- Create: `apps/desktop/src/shared/secrets.ts`
- Create: `apps/desktop/src/main/secrets/secrets-store.ts`
- Test: `apps/desktop/src/main/secrets/secrets-store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks import exactly these):
  - `shared/secrets.ts`: `API_KEY_NAMES`, `type ApiKeyName`, `type KeySource = "app" | "env" | "none"`, `interface KeyStatus { name: ApiKeyName; set: boolean; source: KeySource; last4: string | null; envAlsoSet: boolean; unreadable: boolean }`, `interface SecretsView { canSave: boolean; fileUnreadable: boolean; keys: KeyStatus[] }`, `type KeyTestResult = { result: "ok" } | { result: "unauthorized" } | { result: "unreachable" } | { result: "error"; status?: number }`, `API_KEY_MAX_LENGTH = 512`, `ENV_FALLBACK: Record<ApiKeyName, readonly string[]>`, `isApiKeyName(value: unknown): value is ApiKeyName`, `normalizeKeyValue(raw: string): string | null`, `INVALID_KEY_MESSAGE`, `CANNOT_ENCRYPT_MESSAGE`.
  - `main/secrets/secrets-store.ts`: `interface SecretCrypto { isEncryptionAvailable(): boolean; encryptString(plain: string): Buffer; decryptString(cipher: Buffer): string }`, `class SecretsError extends Error { code: "CANNOT_ENCRYPT" | "INVALID_VALUE" | "UNKNOWN_KEY" }`, `interface SecretsStore { view(): SecretsView; active(name: ApiKeyName): string | null; set(name: ApiKeyName, value: string): SecretsView; remove(name: ApiKeyName): SecretsView; subscribe(listener: (name: ApiKeyName) => void): () => void }`, `createSecretsStore(options: { filePath: string; crypto: SecretCrypto; env: Readonly<Record<string, string | undefined>>; log?: (message: string) => void }): SecretsStore`.

- [ ] **Step 1: Write the shared module**

```ts
// apps/desktop/src/shared/secrets.ts
/** Settings page keys (spec 2026-10-04 settings and API keys). Shared by main and renderer: no Node imports. */
export const API_KEY_NAMES = ["ANTHROPIC_API_KEY", "TYPESAFE_API_KEY"] as const;
export type ApiKeyName = (typeof API_KEY_NAMES)[number];

export type KeySource = "app" | "env" | "none";

/** What the window may know about a key: never its value. */
export interface KeyStatus {
  name: ApiKeyName;
  set: boolean;
  source: KeySource;
  /** Last four characters of the active value, or null when none is active. */
  last4: string | null;
  /** A saved key is active and the environment also has one (the saved key overrides it). */
  envAlsoSet: boolean;
  /** A saved key exists but could not be decrypted. */
  unreadable: boolean;
}

export interface SecretsView {
  /** False when the OS cannot encrypt, so saving is refused. */
  canSave: boolean;
  /** secrets.json exists but could not be parsed. */
  fileUnreadable: boolean;
  keys: KeyStatus[];
}

export type KeyTestResult =
  | { result: "ok" }
  | { result: "unauthorized" }
  | { result: "unreachable" }
  | { result: "error"; status?: number };

export const API_KEY_MAX_LENGTH = 512;

/** Environment names read, in order, when no key is saved. */
export const ENV_FALLBACK: Record<ApiKeyName, readonly string[]> = {
  ANTHROPIC_API_KEY: ["ANTHROPIC_API_KEY"],
  TYPESAFE_API_KEY: ["TYPESAFE_API_KEY", "JEV_API_KEY"],
};

export const INVALID_KEY_MESSAGE = "A key must be 1 to 512 characters with no spaces or control characters.";
export const CANNOT_ENCRYPT_MESSAGE = "This system cannot encrypt saved keys; set the key in the environment instead.";

export function isApiKeyName(value: unknown): value is ApiKeyName {
  return typeof value === "string" && (API_KEY_NAMES as readonly string[]).includes(value);
}

const FORBIDDEN = /[\s\u0000-\u001f\u007f]/u;

/** Trimmed value, or null when it is empty, too long, or holds whitespace or control characters. */
export function normalizeKeyValue(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > API_KEY_MAX_LENGTH || FORBIDDEN.test(value)) return null;
  return value;
}
```

- [ ] **Step 2: Write the failing store tests**

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/secrets/secrets-store.test.ts`
Expected: FAIL, "Failed to load url ./secrets-store.js".

- [ ] **Step 4: Write the store**

```ts
// apps/desktop/src/main/secrets/secrets-store.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  API_KEY_NAMES,
  CANNOT_ENCRYPT_MESSAGE,
  ENV_FALLBACK,
  INVALID_KEY_MESSAGE,
  isApiKeyName,
  normalizeKeyValue,
} from "../../shared/secrets.js";
import type { ApiKeyName, KeyStatus, SecretsView } from "../../shared/secrets.js";

/** Electron's safeStorage shape (tests pass a fake). */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export class SecretsError extends Error {
  constructor(
    readonly code: "CANNOT_ENCRYPT" | "INVALID_VALUE" | "UNKNOWN_KEY",
    message: string,
  ) {
    super(message);
    this.name = "SecretsError";
  }
}

export interface SecretsStore {
  view(): SecretsView;
  /** The active value: saved, else environment, else null. Main process only; never sent to a window. */
  active(name: ApiKeyName): string | null;
  set(name: ApiKeyName, value: string): SecretsView;
  remove(name: ApiKeyName): SecretsView;
  subscribe(listener: (name: ApiKeyName) => void): () => void;
}

export interface SecretsStoreOptions {
  filePath: string;
  crypto: SecretCrypto;
  env: Readonly<Record<string, string | undefined>>;
  log?: (message: string) => void;
}

interface SecretsFile {
  version: 1;
  keys: Partial<Record<ApiKeyName, string>>;
}

function readFile(filePath: string): { keys: Partial<Record<ApiKeyName, string>>; unreadable: boolean } {
  if (!existsSync(filePath)) return { keys: {}, unreadable: false };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
      return { keys: {}, unreadable: true };
    }
    const raw = (parsed as { keys?: unknown }).keys;
    const keys: Partial<Record<ApiKeyName, string>> = {};
    if (typeof raw === "object" && raw !== null) {
      for (const [name, cipher] of Object.entries(raw)) {
        if (isApiKeyName(name) && typeof cipher === "string") keys[name] = cipher;
      }
    }
    return { keys, unreadable: false };
  } catch {
    return { keys: {}, unreadable: true };
  }
}

/** Writes beside the target, then renames, so a failure leaves the old file whole (Review Focus 3). */
function writeAtomically(filePath: string, file: SecretsFile): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createSecretsStore(options: SecretsStoreOptions): SecretsStore {
  const log = options.log ?? (() => {});
  const loaded = readFile(options.filePath);
  if (loaded.unreadable) log("secrets file could not be read; saved keys are ignored until the next save");
  let ciphers: Partial<Record<ApiKeyName, string>> = loaded.keys;
  let fileUnreadable = loaded.unreadable;
  const plain = new Map<ApiKeyName, string>();
  const unreadable = new Set<ApiKeyName>();
  const listeners = new Set<(name: ApiKeyName) => void>();

  const saved = (name: ApiKeyName): string | null => {
    const known = plain.get(name);
    if (known !== undefined) return known;
    const cipher = ciphers[name];
    if (cipher === undefined || unreadable.has(name)) return null;
    try {
      const value = normalizeKeyValue(options.crypto.decryptString(Buffer.from(cipher, "base64")));
      if (value === null) throw new Error("empty");
      plain.set(name, value);
      return value;
    } catch {
      unreadable.add(name);
      log(`a saved ${name} could not be decrypted`);
      return null;
    }
  };

  const fromEnv = (name: ApiKeyName): string | null => {
    for (const envName of ENV_FALLBACK[name]) {
      const value = (options.env[envName] ?? "").trim();
      if (value !== "") return value;
    }
    return null;
  };

  const status = (name: ApiKeyName): KeyStatus => {
    const savedValue = saved(name);
    const envValue = fromEnv(name);
    const activeValue = savedValue ?? envValue;
    return {
      name,
      set: activeValue !== null,
      source: savedValue !== null ? "app" : envValue !== null ? "env" : "none",
      last4: activeValue === null ? null : activeValue.slice(-4),
      envAlsoSet: savedValue !== null && envValue !== null,
      unreadable: unreadable.has(name),
    };
  };

  const view = (): SecretsView => ({
    canSave: options.crypto.isEncryptionAvailable(),
    fileUnreadable,
    keys: API_KEY_NAMES.map(status),
  });

  /** Writes the file first; memory changes only after the write succeeded, and listeners run last. */
  const commit = (name: ApiKeyName, next: Partial<Record<ApiKeyName, string>>, value: string | null): void => {
    writeAtomically(options.filePath, { version: 1, keys: next });
    ciphers = next;
    fileUnreadable = false;
    if (value === null) plain.delete(name);
    else plain.set(name, value);
    unreadable.delete(name);
    for (const listener of listeners) listener(name);
  };

  const requireName = (name: unknown): ApiKeyName => {
    if (!isApiKeyName(name)) throw new SecretsError("UNKNOWN_KEY", "Unknown key name.");
    return name;
  };

  return {
    view,
    active: (name) => saved(name) ?? fromEnv(name),
    set(name, raw) {
      const key = requireName(name);
      const value = normalizeKeyValue(raw);
      if (value === null) throw new SecretsError("INVALID_VALUE", INVALID_KEY_MESSAGE);
      if (!options.crypto.isEncryptionAvailable()) throw new SecretsError("CANNOT_ENCRYPT", CANNOT_ENCRYPT_MESSAGE);
      const cipher = options.crypto.encryptString(value).toString("base64");
      commit(key, { ...ciphers, [key]: cipher }, value);
      return view();
    },
    remove(name) {
      const key = requireName(name);
      const next = { ...ciphers };
      delete next[key];
      commit(key, next, null);
      return view();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/secrets/secrets-store.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec tsc --noEmit -p tsconfig.json
perl -e 'alarm 120; exec @ARGV' pnpm exec eslint apps/desktop/src/shared/secrets.ts apps/desktop/src/main/secrets
git add apps/desktop/src/shared/secrets.ts apps/desktop/src/main/secrets
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): a secrets store that keeps API keys encrypted through the OS keychain"
```

---

### Task 2: Anthropic key check

**Files:**
- Modify: `packages/jev-router/src/narrator/anthropic-transport.ts`
- Test: `packages/jev-router/src/narrator/anthropic-transport.test.ts`

**Interfaces:**
- Consumes: the existing transport options, `ANTHROPIC_BASE_URL` and `suppressedEnvHeaders()` in the same file.
- Produces: `type AnthropicKeyCheck = { result: "ok" } | { result: "unauthorized" } | { result: "unreachable" } | { result: "error"; status?: number }` and `checkAnthropicKey(options: { apiKey: string; baseURL?: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<AnthropicKeyCheck>`, exported from `@jevcode/jev-router` (`narrator/index.ts` already has `export * from "./anthropic-transport.js"` and the package root `export * from "./narrator/index.js"`). Structurally identical to desktop's `KeyTestResult` (Task 1).

- [ ] **Step 1: Write the failing tests** (append to the existing test file; it already uses a `fetch` seam)

```ts
import { checkAnthropicKey } from "./anthropic-transport.js";

describe("checkAnthropicKey", () => {
  const ok = () => new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), { status: 200, headers: { "content-type": "application/json" } });
  const status = (code: number) =>
    new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: code, headers: { "content-type": "application/json" } });

  it("lists models once against the pinned base URL with the key and no bearer token", async () => {
    const calls: Request[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return ok();
    });
    await expect(checkAnthropicKey({ apiKey: "sk-test", fetch: fetchSpy as unknown as typeof fetch })).resolves.toEqual({ result: "ok" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url.startsWith("https://api.anthropic.com/v1/models")).toBe(true);
    expect(calls[0]!.headers.get("x-api-key")).toBe("sk-test");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it.each([
    [401, { result: "unauthorized" }],
    [403, { result: "unauthorized" }],
    [500, { result: "error", status: 500 }],
  ] as const)("maps HTTP %i without retrying", async (code, expected) => {
    const fetchSpy = vi.fn(async () => status(code));
    await expect(checkAnthropicKey({ apiKey: "sk-test", fetch: fetchSpy as unknown as typeof fetch })).resolves.toEqual(expected);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a network failure or timeout as unreachable", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(checkAnthropicKey({ apiKey: "sk-test", fetch: offline as unknown as typeof fetch })).resolves.toEqual({ result: "unreachable" });
    const hang = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await expect(checkAnthropicKey({ apiKey: "sk-test", fetch: hang as unknown as typeof fetch, timeoutMs: 50 })).resolves.toEqual({ result: "unreachable" });
  });

  it("treats a blank key as unauthorized without a request", async () => {
    const fetchSpy = vi.fn(async () => ok());
    await expect(checkAnthropicKey({ apiKey: "  ", fetch: fetchSpy as unknown as typeof fetch })).resolves.toEqual({ result: "unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/jev-router exec vitest run src/narrator/anthropic-transport.test.ts`
Expected: FAIL, "checkAnthropicKey is not a function" (or an import error).

- [ ] **Step 3: Implement**

In `anthropic-transport.ts`, factor the constructor into one helper used by both the transport and the check:

```ts
function createHardenedClient(options: { apiKey: string; baseURL?: string; fetch?: typeof fetch }): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    baseURL: options.baseURL ?? ANTHROPIC_BASE_URL,
    defaultHeaders: suppressedEnvHeaders(),
    maxRetries: 0,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export type AnthropicKeyCheck =
  | { result: "ok" }
  | { result: "unauthorized" }
  | { result: "unreachable" }
  | { result: "error"; status?: number };

/** Settings page "Test": lists models (no tokens, no project data). Button-triggered only. */
export async function checkAnthropicKey(options: {
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<AnthropicKeyCheck> {
  if (options.apiKey.trim() === "") return { result: "unauthorized" };
  const client = createHardenedClient({ ...options, apiKey: options.apiKey.trim() });
  try {
    await client.models.list({ limit: 1 }, { timeout: options.timeoutMs ?? 10_000 });
    return { result: "ok" };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return { result: "unauthorized" };
    }
    // APIConnectionTimeoutError extends APIConnectionError.
    if (error instanceof Anthropic.APIConnectionError) return { result: "unreachable" };
    if (error instanceof Anthropic.APIError && typeof error.status === "number") return { result: "error", status: error.status };
    return { result: "error" };
  }
}
```

Replace the `new Anthropic({...})` in `createAnthropicNarratorTransport` with `createHardenedClient(options)`. The existing `export *` lines publish the new names; add nothing to the index files.

- [ ] **Step 4: Run the tests to verify they pass, then the package suite**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/jev-router exec vitest run src/narrator/anthropic-transport.test.ts` → PASS.
Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/jev-router test` → PASS (the existing transport tests still pass after the refactor).
Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/jev-router build` (desktop imports the dist).

- [ ] **Step 5: Commit**

```bash
git add packages/jev-router/src/narrator/anthropic-transport.ts packages/jev-router/src/narrator/anthropic-transport.test.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(jev-router): check an Anthropic key by listing models on the hardened client"
```

---

### Task 3: Secrets IPC

**Files:**
- Modify: `apps/desktop/src/shared/local-channels.ts`, `apps/desktop/src/shared/api.ts`, `apps/desktop/src/shared/errors.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/renderer/test-support/fake-bridge.ts`
- Test: `apps/desktop/src/main/ipc.test.ts` (new describe), `apps/desktop/src/main/trace-allowlist.test.ts`, `apps/desktop/src/shared/secrets-ipc.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`SecretsStore`, `SecretsError`, `SecretsView`, `KeyTestResult`, `API_KEY_NAMES`, `API_KEY_MAX_LENGTH`).
- Produces:
  - Channels `secrets:status`, `secrets:set`, `secrets:remove`, `secrets:test` (renderer → main) and `secrets:updated` (main → renderer), in `RendererToMainLocalChannels` as `secretsStatus`, `secretsSet`, `secretsRemove`, `secretsTest` and `MainToRendererLocalChannels.secretsUpdated`.
  - `IpcErrorCode` gains `"SECRETS_UNAVAILABLE"`.
  - `IpcDeps` gains `secrets?: SecretsStore` and `checkKey?: (apiKey: string) => Promise<KeyTestResult>`.
  - `JevcodeApi.secrets: { view(): Promise<SecretsView>; set(name: ApiKeyName, value: string): Promise<SecretsView>; remove(name: ApiKeyName): Promise<SecretsView>; test(name: "ANTHROPIC_API_KEY"): Promise<KeyTestResult> }` and `JevcodeApi.onSecretsUpdated(listener: (view: SecretsView) => void): () => void`.

- [ ] **Step 1: Write the failing schema tests**

```ts
// apps/desktop/src/shared/secrets-ipc.test.ts
import { describe, expect, it } from "vitest";

import { parseFromMain, parseToMain } from "./ipc-registry.js";

describe("secrets channels", () => {
  it("accepts allowlisted names and rejects others", () => {
    expect(parseToMain("secrets:set", { name: "ANTHROPIC_API_KEY", value: "sk-x" })).toEqual({ name: "ANTHROPIC_API_KEY", value: "sk-x" });
    expect(() => parseToMain("secrets:set", { name: "OPENAI_API_KEY", value: "sk-x" })).toThrow();
    expect(() => parseToMain("secrets:remove", { name: "ANTHROPIC_API_KEY", extra: 1 })).toThrow();
    expect(() => parseToMain("secrets:test", { name: "TYPESAFE_API_KEY" })).toThrow();
  });

  it("never echoes a rejected value in the parse error", () => {
    const value = `sk-${"x".repeat(5000)}`;
    let message = "";
    try {
      parseToMain("secrets:set", { name: "ANTHROPIC_API_KEY", value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(value.slice(0, 40));
  });

  it("carries statuses, never values, from main", () => {
    const view = {
      canSave: true,
      fileUnreadable: false,
      keys: [{ name: "ANTHROPIC_API_KEY", set: true, source: "app", last4: "1234", envAlsoSet: false, unreadable: false }],
    };
    expect(parseFromMain("secrets:updated", view)).toEqual(view);
    expect(() => parseFromMain("secrets:updated", { ...view, keys: [{ ...view.keys[0], value: "sk-full" }] })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/shared/secrets-ipc.test.ts`
Expected: FAIL, "toMain channel not registered: secrets:set".

- [ ] **Step 3: Add the channels and schemas** (`local-channels.ts`)

```ts
import { API_KEY_MAX_LENGTH, API_KEY_NAMES } from "./secrets.js";

// RendererToMainLocalChannels:
  secretsStatus: "secrets:status",
  secretsSet: "secrets:set",
  secretsRemove: "secrets:remove",
  secretsTest: "secrets:test",
// MainToRendererLocalChannels:
  secretsUpdated: "secrets:updated",

const API_KEY_NAME_ENUM = z.enum(API_KEY_NAMES);
export const SecretsStatusPayloadSchema = z.object({}).strict();
/** Shape only; main trims and validates the value (no echo, Task 1's normalizeKeyValue). */
export const SecretsSetPayloadSchema = z.object({ name: API_KEY_NAME_ENUM, value: z.string().max(API_KEY_MAX_LENGTH * 4) }).strict();
export const SecretsRemovePayloadSchema = z.object({ name: API_KEY_NAME_ENUM }).strict();
export const SecretsTestPayloadSchema = z.object({ name: z.literal("ANTHROPIC_API_KEY") }).strict();
export const KeyStatusSchema = z
  .object({
    name: API_KEY_NAME_ENUM,
    set: z.boolean(),
    source: z.enum(["app", "env", "none"]),
    last4: z.string().max(4).nullable(),
    envAlsoSet: z.boolean(),
    unreadable: z.boolean(),
  })
  .strict();
export const SecretsViewSchema = z.object({ canSave: z.boolean(), fileUnreadable: z.boolean(), keys: z.array(KeyStatusSchema) }).strict();

// localToMain:
  [RendererToMainLocalChannels.secretsStatus]: SecretsStatusPayloadSchema,
  [RendererToMainLocalChannels.secretsSet]: SecretsSetPayloadSchema,
  [RendererToMainLocalChannels.secretsRemove]: SecretsRemovePayloadSchema,
  [RendererToMainLocalChannels.secretsTest]: SecretsTestPayloadSchema,
// localFromMain:
  [MainToRendererLocalChannels.secretsUpdated]: SecretsViewSchema,
```

The parse error message is zod 3's issue list: a `too_big` issue carries the maximum, never the received string, and an `invalid_enum_value` issue echoes only the key name, so a rejected value never appears in the error (the Step 1 test pins this).

- [ ] **Step 4: Run the schema tests to verify they pass**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Write the failing handler tests** (append to `ipc.test.ts`; reuse its `makeDeps`, `registerAndCapture`, `seedRepoAndSession`, `stubRuntime`, `TRUSTED_EVENT`)

```ts
import { createSecretsStore } from "./secrets/secrets-store.js";

function memoryStore(env: Record<string, string | undefined> = {}, canEncrypt = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-ipc-secrets-"));
  const store = createSecretsStore({
    filePath: path.join(dir, "secrets.json"),
    crypto: {
      isEncryptionAvailable: () => canEncrypt,
      encryptString: (plain) => Buffer.from(`enc:${plain}`),
      decryptString: (cipher) => cipher.toString().slice(4),
    },
    env,
  });
  return { store, dir };
}

describe("secrets IPC (settings page)", () => {
  it("returns statuses only and saves, removes and tests keys", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const { store, dir } = memoryStore();
    const checkKey = vi.fn(async (_apiKey: string) => ({ result: "ok" as const }));
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), secrets: store, checkKey });
    const set = handlers.get("secrets:set")!;
    const view = (await set(TRUSTED_EVENT, { name: "ANTHROPIC_API_KEY", value: "sk-ant-abcdef-7777" })) as { keys: { source: string; last4: string }[] };
    expect(view.keys[0]).toMatchObject({ source: "app", last4: "7777" });
    expect(JSON.stringify(view)).not.toContain("sk-ant-abcdef-7777");
    await expect(handlers.get("secrets:test")!(TRUSTED_EVENT, { name: "ANTHROPIC_API_KEY" })).resolves.toEqual({ result: "ok" });
    expect(checkKey).toHaveBeenCalledWith("sk-ant-abcdef-7777");
    await expect(handlers.get("secrets:remove")!(TRUSTED_EVENT, { name: "ANTHROPIC_API_KEY" })).resolves.toMatchObject({ keys: [{ source: "none" }, { source: "none" }] });
    await expect(handlers.get("secrets:test")!(TRUSTED_EVENT, { name: "ANTHROPIC_API_KEY" })).resolves.toEqual({ result: "error" });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps refusals to typed errors that do not repeat the value", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const { store, dir } = memoryStore({}, false);
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), secrets: store });
    await expect(handlers.get("secrets:set")!(TRUSTED_EVENT, { name: "ANTHROPIC_API_KEY", value: "sk-ant-abcdef-7777" })).rejects.toMatchObject({
      message: expect.not.stringContaining("sk-ant-abcdef-7777"),
    });
    await expect(handlers.get("secrets:set")!(TRUSTED_EVENT, { name: "ANTHROPIC_API_KEY", value: "has space" })).rejects.toMatchObject({
      message: expect.not.stringContaining("has space"),
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects every secrets channel from a trace window (Review Focus 5)", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const { store, dir } = memoryStore();
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state, () => "trace"), secrets: store });
    for (const [channel, payload] of [
      ["secrets:status", {}],
      ["secrets:set", { name: "ANTHROPIC_API_KEY", value: "sk-x" }],
      ["secrets:remove", { name: "ANTHROPIC_API_KEY" }],
      ["secrets:test", { name: "ANTHROPIC_API_KEY" }],
    ] as const) {
      await expect(handlers.get(channel)!(TRUSTED_EVENT, payload)).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

Also add to `trace-allowlist.test.ts`:

```ts
it("keeps every secrets channel and push away from trace windows", () => {
  for (const channel of ["secrets:status", "secrets:set", "secrets:remove", "secrets:test"]) {
    expect(isChannelAllowed(channel, "trace")).toBe(false);
    expect(isChannelAllowed(channel, "main")).toBe(true);
  }
  expect(isPushAllowed("secrets:updated", "trace")).toBe(false);
});
```

(Import `mkdtempSync`, `rmSync`, `os`, `path` at the top of `ipc.test.ts` if they are not already imported.)

- [ ] **Step 6: Run to verify failure**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/ipc.test.ts src/main/trace-allowlist.test.ts`
Expected: FAIL on the new describes (no `secrets:set` handler).

- [ ] **Step 7: Implement the handlers, error code and API**

`errors.ts`: add `| "SECRETS_UNAVAILABLE"` to `IpcErrorCode`.

`ipc.ts` (inside `registerIpcHandlers`, after the preferences handlers):

```ts
import { SecretsError } from "./secrets/secrets-store.js";
import type { SecretsStore } from "./secrets/secrets-store.js";
import type { KeyTestResult, SecretsView } from "../shared/secrets.js";

// IpcDeps:
  /** Settings page keys (main window only; trace windows are refused by the allowlist). */
  secrets?: SecretsStore;
  /** Anthropic key check (jev-router checkAnthropicKey); the active value never leaves main. */
  checkKey?: (apiKey: string) => Promise<KeyTestResult>;

  const requireSecrets = (): SecretsStore => {
    if (deps.secrets === undefined) throw new IpcError("SECRETS_UNAVAILABLE", "Saved keys are not available in this window.");
    return deps.secrets;
  };
  const secretsCall = (fn: () => SecretsView): SecretsView => {
    let view: SecretsView;
    try {
      view = fn();
    } catch (error) {
      if (error instanceof SecretsError) {
        throw new IpcError(error.code === "CANNOT_ENCRYPT" ? "SECRETS_UNAVAILABLE" : "INVALID_PAYLOAD", error.message);
      }
      throw error;
    }
    sendToRenderer(MainToRendererLocalChannels.secretsUpdated, view);
    // The narrator note and availability depend on the active Anthropic key (Task 4 wires the switch to the store).
    sendToRenderer(
      MainToRendererLocalChannels.preferencesUpdated,
      withNarratorAvailability(readAgentPreferences((key) => deps.db.getPreference(key))),
    );
    return view;
  };

  handle(RendererToMainLocalChannels.secretsStatus, () => requireSecrets().view());
  handle(RendererToMainLocalChannels.secretsSet, ({ name, value }) => secretsCall(() => requireSecrets().set(name, value)));
  handle(RendererToMainLocalChannels.secretsRemove, ({ name }) => secretsCall(() => requireSecrets().remove(name)));
  handle(RendererToMainLocalChannels.secretsTest, async ({ name }): Promise<KeyTestResult> => {
    const apiKey = requireSecrets().active(name);
    if (apiKey === null || deps.checkKey === undefined) return { result: "error" };
    return deps.checkKey(apiKey);
  });
```

The handle wrapper logs `error.message` on failure; every message above is fixed text, so no value is logged.

`api.ts`: add the `secrets` block and `onSecretsUpdated` to `JevcodeApi` and `createJevcodeApi`:

```ts
import type { ApiKeyName, KeyTestResult, SecretsView } from "./secrets.js";

  secrets: {
    view(): Promise<SecretsView>;
    set(name: ApiKeyName, value: string): Promise<SecretsView>;
    remove(name: ApiKeyName): Promise<SecretsView>;
    test(name: "ANTHROPIC_API_KEY"): Promise<KeyTestResult>;
  };
  onSecretsUpdated(listener: (view: SecretsView) => void): () => void;

// in createJevcodeApi:
    secrets: {
      view: async () => (await invoke("secrets:status", {})) as SecretsView,
      set: async (name, value) => (await invoke("secrets:set", { name, value })) as SecretsView,
      remove: async (name) => (await invoke("secrets:remove", { name })) as SecretsView,
      test: async (name) => (await invoke("secrets:test", { name })) as KeyTestResult,
    },
    onSecretsUpdated: (listener) => on(MainToRendererLocalChannels.secretsUpdated, listener),
```

`fake-bridge.ts`: add `secrets: { view: vi.fn(async () => EMPTY_SECRETS), set: vi.fn(async () => EMPTY_SECRETS), remove: vi.fn(async () => EMPTY_SECRETS), test: vi.fn(async () => ({ result: "ok" })) }` and `onSecretsUpdated: () => () => undefined`, with `EMPTY_SECRETS` = both keys `source: "none"`, `canSave: true`, `fileUnreadable: false`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/ipc.test.ts src/main/trace-allowlist.test.ts src/shared/secrets-ipc.test.ts src/shared/api.test.ts src/shared/ipc-registry.test.ts`
Expected: PASS. If `api.test.ts` or `ipc-registry.test.ts` pin the full channel list, add the new names there.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec tsc --noEmit -p tsconfig.json
perl -e 'alarm 120; exec @ARGV' pnpm exec eslint apps/desktop/src/shared apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/trace-allowlist.test.ts apps/desktop/src/renderer/test-support/fake-bridge.ts
git add apps/desktop/src/shared apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/trace-allowlist.test.ts apps/desktop/src/renderer/test-support/fake-bridge.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): secrets IPC that carries key statuses, never values, to the main window only"
```

---

### Task 4: The narrator follows the active key

**Files:**
- Modify: `apps/desktop/src/main/pipeline/narrator-switch.ts`, `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/src/main/pipeline/narrator-switch.test.ts`, `apps/desktop/src/main/ipc.test.ts`

**Interfaces:**
- Consumes: Task 1 `SecretsStore.active` / `subscribe`; Task 2 `checkAnthropicKey`; Task 3 `IpcDeps.secrets` / `checkKey`.
- Produces: `NarratorSwitchOptions.apiKey?: () => string | null` (when given, it is the only key source; when absent, `env.ANTHROPIC_API_KEY` as today); `narratorAvailability(enabled, env, apiKey?: string | null)`; `NarratorSwitch.refresh(): void` (re-reads the key; notifies when the client or the availability changed).

- [ ] **Step 1: Write the failing switch tests** (append)

```ts
describe("narrator switch with saved keys (settings page)", () => {
  it("rebuilds the client when the active key changes, and only then", () => {
    let key: string | null = "sk-first";
    // Each call returns a fresh fake, so a rebuilt client is a different object.
    const createClient = vi.fn((_apiKey: string) => createFakeNarratorClient({}));
    const narrator = createNarratorSwitch({ enabled: true, env: {}, apiKey: () => key, createClient });
    expect(createClient).not.toHaveBeenCalled();
    const seen: unknown[] = [];
    narrator.subscribe((client) => seen.push(client));
    const first = narrator.current();
    expect(createClient).toHaveBeenLastCalledWith("sk-first");
    narrator.refresh();
    expect(seen).toHaveLength(0);
    key = "sk-second";
    narrator.refresh();
    expect(createClient).toHaveBeenLastCalledWith("sk-second");
    expect(narrator.current()).not.toBe(first);
    expect(seen).toHaveLength(1);
  });

  it("goes off_no_key when the key is removed, and the kill switch still wins", () => {
    let key: string | null = "sk-first";
    const narrator = createNarratorSwitch({ enabled: true, env: {}, apiKey: () => key, createClient: () => createFakeNarratorClient({}) });
    key = null;
    narrator.refresh();
    expect(narrator.availability()).toBe("off_no_key");
    expect(narrator.current()).toBeNull();
    const killed = createNarratorSwitch({ enabled: true, env: { JEVCODE_NARRATOR: "off" }, apiKey: () => "sk-x", createClient: () => createFakeNarratorClient({}) });
    expect(killed.availability()).toBe("off_env");
  });

  it("stays on with the environment key after the saved key is removed (Review Focus 4)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-switch-"));
    const store = createSecretsStore({
      filePath: path.join(dir, "secrets.json"),
      crypto: { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(`enc:${p}`), decryptString: (c) => c.toString().slice(4) },
      env: { ANTHROPIC_API_KEY: "sk-env-key" },
    });
    const createClient = vi.fn(() => createFakeNarratorClient({}));
    const narrator = createNarratorSwitch({ enabled: true, env: {}, apiKey: () => store.active("ANTHROPIC_API_KEY"), createClient });
    store.subscribe(() => narrator.refresh());
    store.set("ANTHROPIC_API_KEY", "sk-saved-key");
    expect(createClient).toHaveBeenLastCalledWith("sk-saved-key");
    store.remove("ANTHROPIC_API_KEY");
    expect(narrator.availability()).toBe("on");
    expect(createClient).toHaveBeenLastCalledWith("sk-env-key");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

(Import `mkdtempSync`, `rmSync` from `node:fs`, `os` from `node:os`, `path` from `node:path`, and `createSecretsStore` from `../secrets/secrets-store.js`.)

- [ ] **Step 2: Run to verify failure**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/narrator-switch.test.ts`
Expected: FAIL, "narrator.refresh is not a function".

- [ ] **Step 3: Implement**

```ts
export interface NarratorSwitch {
  current(): NarratorClient | null;
  availability(): NarratorAvailability;
  setEnabled(enabled: boolean): void;
  /** Re-reads the active key (Settings page save or remove); notifies when the client or availability changed. */
  refresh(): void;
  subscribe(listener: (client: NarratorClient | null) => void): () => void;
}

export interface NarratorSwitchOptions {
  enabled: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** The active Anthropic key (secrets store: saved, else environment). Absent: env.ANTHROPIC_API_KEY. */
  apiKey?: () => string | null;
  createClient?: (apiKey: string) => NarratorClient;
}

export function narratorAvailability(
  enabled: boolean,
  env: Readonly<Record<string, string | undefined>>,
  apiKey?: string | null,
): NarratorAvailability {
  if ((env[NARRATOR_KILL_ENV] ?? "").trim().toLowerCase() === "off") return "off_env";
  if (!enabled) return "off_setting";
  const key = apiKey === undefined ? env[NARRATOR_API_KEY_ENV] ?? "" : apiKey ?? "";
  if (key.trim() === "") return "off_no_key";
  return "on";
}

export function createNarratorSwitch(options: NarratorSwitchOptions): NarratorSwitch {
  const createClient =
    options.createClient ?? ((apiKey: string) => createNarratorClient(createAnthropicNarratorTransport({ apiKey })));
  const keyNow = (): string =>
    (options.apiKey === undefined ? (options.env[NARRATOR_API_KEY_ENV] ?? "") : (options.apiKey() ?? "")).trim();
  let enabled = options.enabled;
  // Built lazily on the first current() while "on", and rebuilt when the active key changes.
  let client: NarratorClient | null = null;
  let clientKey = "";
  const listeners = new Set<(client: NarratorClient | null) => void>();

  const availability = (): NarratorAvailability => narratorAvailability(enabled, options.env, keyNow());
  const resolve = (): NarratorClient | null => {
    if (availability() !== "on") return null;
    const key = keyNow();
    if (client === null || clientKey !== key) {
      client = createClient(key);
      clientKey = key;
    }
    return client;
  };

  // What listeners last saw. Compared by availability and key, not by client, so a check never builds a client
  // for a key that is about to be replaced, and an "off" switch never builds one at all.
  let seen = { availability: availability(), key: keyNow() };
  const notifyIfChanged = (): void => {
    const next = { availability: availability(), key: keyNow() };
    const changed = next.availability !== seen.availability || (next.availability === "on" && next.key !== seen.key);
    seen = next;
    if (!changed) return;
    // Without a key the client stays null, but the reason changes (status.narrator "unavailable" vs "off", R3).
    const after = resolve();
    for (const listener of listeners) listener(after);
  };

  return {
    current: resolve,
    availability,
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      notifyIfChanged();
    },
    refresh: notifyIfChanged,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

Behaviour kept from today: the client is built lazily; turning the setting off and on again with the same key reuses the cached client; `setEnabled` under `JEVCODE_NARRATOR=off` notifies nobody (availability stays `off_env`). Run the existing switch tests unchanged to confirm.

- [ ] **Step 4: Wire the store in main** (`index.ts`, inside `app.whenReady().then`, before `createNarratorSwitch`)

```ts
import { app, BrowserWindow, safeStorage, webContents } from "electron";
import { checkAnthropicKey } from "@jevcode/jev-router";
import { createSecretsStore } from "./secrets/secrets-store.js";
import type { SecretCrypto } from "./secrets/secrets-store.js";

// Module scope, next to `const SMOKE`:
/** Smoke runs: the page shows saving as possible, but nothing is ever encrypted or decrypted. */
const SMOKE_SECRET_CRYPTO: SecretCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: () => {
    throw new Error("saved keys are disabled in smoke runs");
  },
  decryptString: () => {
    throw new Error("saved keys are disabled in smoke runs");
  },
};

// Inside app.whenReady().then, replacing the current createNarratorSwitch call (index.ts:169):

  const secrets = createSecretsStore({
    // Smokes point this at a temp file (Task 7); otherwise the app's data folder.
    filePath: process.env["JEVCODE_SECRETS_FILE"] ?? path.join(app.getPath("userData"), "secrets.json"),
    // A smoke never touches the keychain: a prompt there would block the main thread until someone answers it.
    crypto: SMOKE ? SMOKE_SECRET_CRYPTO : safeStorage,
    env: process.env,
    log: (message) => console.error(`[secrets] ${message}`),
  });
  const narratorSwitch = createNarratorSwitch({
    enabled: readAgentPreferences((key) => openedDb.getPreference(key)).explainWithModel,
    env: process.env,
    apiKey: () => secrets.active("ANTHROPIC_API_KEY"),
  });
  secrets.subscribe((name) => {
    if (name === "ANTHROPIC_API_KEY") narratorSwitch.refresh();
  });
```

and pass to `registerIpcHandlers({ ... })`: `secrets, checkKey: (apiKey) => checkAnthropicKey({ apiKey }),`.

- [ ] **Step 5: Add an IPC test that the preferences push reflects the new key**

```ts
it("pushes the narrator availability that follows a saved key", async () => {
  const { db, state } = seedRepoAndSession();
  const { runtime } = stubRuntime();
  const { store, dir } = memoryStore();
  const narrator = createNarratorSwitch({ enabled: true, env: {}, apiKey: () => store.active("ANTHROPIC_API_KEY"), createClient: () => createFakeNarratorClient({}) });
  store.subscribe(() => narrator.refresh());
  const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), secrets: store, narrator });
  await expect(handlers.get("preferences:get")!(TRUSTED_EVENT, {})).resolves.toMatchObject({ narratorAvailability: "off_no_key" });
  await handlers.get("secrets:set")!(TRUSTED_EVENT, { name: "ANTHROPIC_API_KEY", value: "sk-ant-abcdef-7777" });
  await expect(handlers.get("preferences:get")!(TRUSTED_EVENT, {})).resolves.toMatchObject({ narratorAvailability: "on" });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 6: Run the tests**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/narrator-switch.test.ts src/main/ipc.test.ts`
Expected: PASS (existing switch tests unchanged).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec tsc --noEmit -p tsconfig.json
perl -e 'alarm 120; exec @ARGV' pnpm exec eslint apps/desktop/src/main/pipeline/narrator-switch.ts apps/desktop/src/main/pipeline/narrator-switch.test.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.test.ts
git add apps/desktop/src/main/pipeline/narrator-switch.ts apps/desktop/src/main/pipeline/narrator-switch.test.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.test.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): the narrator uses the saved Anthropic key and re-keys when it changes"
```

---

### Task 5: Agent backend and Jev client preferences

**Files:**
- Modify: `apps/desktop/src/shared/prefs.ts`, `apps/desktop/src/shared/local-channels.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/pipeline/types.ts`, `apps/desktop/src/main/pipeline/pipeline-runtime.ts`, `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/pipeline/agent-mode.ts`
- Test: `apps/desktop/src/shared/prefs.test.ts`, `apps/desktop/src/shared/prefs-ipc.test.ts`, `apps/desktop/src/main/pipeline/agent-mode.test.ts` (new), `apps/desktop/src/main/ipc.test.ts`, `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 `SecretsStore.active("TYPESAFE_API_KEY")`.
- Produces:
  - `prefs.ts`: `AGENT_BACKEND_OPTIONS = ["auto", "codex", "mock"]`, `type AgentBackendOption`, `JEV_CLIENT_OPTIONS = ["auto", "typesafe", "offline"]`, `type JevClientOption`, `AGENT_BACKEND_PREF_KEY = "agent.backend"`, `JEV_CLIENT_PREF_KEY = "jev.client"`; `AgentPreferences.agentBackend`, `AgentPreferences.jevClient`; `AgentPreferencesPatch.agentBackend?`, `.jevClient?`; `PreferencesView.agentBackendOverride?: string`, `.jevClientOverride?: string`; `normalizeAgentBackend`, `normalizeJevClient`, `agentBackendOverride(env): string | undefined`, `jevClientOverride(env): string | undefined`, `jevClientEnvValue(option: JevClientOption): "typesafe" | "degrade" | undefined`.
  - `agent-mode.ts`: `chooseAgentMode(explicit: AgentMode | undefined, envValue: string | undefined, preference: AgentMode | undefined): AgentMode`.
  - `PipelineRuntimeOptions.agentModeFor?: () => AgentMode | undefined` and `PipelineRuntimeOptions.createJevClient?: () => JevClient`.
  - `IpcDeps.env?: Readonly<Record<string, string | undefined>>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/src/main/pipeline/agent-mode.test.ts
import { describe, expect, it } from "vitest";

import { chooseAgentMode } from "./agent-mode.js";

describe("chooseAgentMode", () => {
  it.each([
    ["mock", undefined, "codex", "mock"],
    [undefined, "codex", "mock", "codex"],
    [undefined, "replay", undefined, "replay"],
    [undefined, "nonsense", "mock", "mock"],
    [undefined, undefined, "mock", "mock"],
    [undefined, undefined, undefined, "auto"],
  ] as const)("explicit=%s env=%s pref=%s → %s", (explicit, env, pref, expected) => {
    expect(chooseAgentMode(explicit, env, pref)).toBe(expected);
  });
});
```

Append to `prefs.test.ts`:

```ts
describe("agent backend and Jev client preferences", () => {
  it("default to auto and ignore unknown stored values", () => {
    const prefs = readAgentPreferences((key) => ({ "agent.backend": "bogus", "jev.client": 7 })[key]);
    expect(prefs).toMatchObject({ agentBackend: "auto", jevClient: "auto" });
    expect(applyPreferencesPatch(prefs, { agentBackend: "mock", jevClient: "offline" })).toMatchObject({ agentBackend: "mock", jevClient: "offline" });
  });

  it("read environment overrides and map offline to degrade", () => {
    expect(agentBackendOverride({ JEVC_AGENT: "mock" })).toBe("mock");
    expect(agentBackendOverride({ JEVC_AGENT: "replay" })).toBe("replay");
    expect(agentBackendOverride({ JEVC_AGENT: "x" })).toBeUndefined();
    expect(jevClientOverride({ JEVC_JEV_CLIENT: "degrade" })).toBe("degrade");
    expect(jevClientOverride({})).toBeUndefined();
    expect(jevClientEnvValue("offline")).toBe("degrade");
    expect(jevClientEnvValue("typesafe")).toBe("typesafe");
    expect(jevClientEnvValue("auto")).toBeUndefined();
  });
});
```

Append to `ipc.test.ts`:

```ts
it("stores the backend and Jev client and reports environment overrides", async () => {
  const { db, state } = seedRepoAndSession();
  const { runtime } = stubRuntime();
  const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), env: { JEVC_AGENT: "mock" } });
  await expect(handlers.get("preferences:set")!(TRUSTED_EVENT, { agentBackend: "codex", jevClient: "offline" })).resolves.toMatchObject({
    agentBackend: "codex",
    jevClient: "offline",
    agentBackendOverride: "mock",
  });
  expect(db.getPreference("agent.backend")).toBe("codex");
  expect(db.getPreference("jev.client")).toBe("offline");
  db.close();
});
```

Append to `pipeline-runtime.test.ts` (use the file's existing session-start helper and mock script; the point is the factory call):

```ts
describe("PipelineRuntime with Settings page choices", () => {
  it("builds each session's Jev client from the factory and asks the preference for the backend", async () => {
    vi.stubEnv("JEVC_AGENT", "");
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/settings-factory");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    db.upsertRepository({ id: "repo-test", path: fixtureDir("rate-limit"), gitRoot: fixtureDir("rate-limit"), branch: "test", baseCommit: "test" });
    db.createSession({ id: "sess-settings", repoId: "repo-test", prompt: "settings" });
    const createJevClient = vi.fn(() => new DegradeClient());
    const agentModeFor = vi.fn(() => "replay" as const);
    const { emit } = collectEmit();
    const runtime = new PipelineRuntime({ db, emit, evidence: false, log: () => {}, createJevClient, agentModeFor });
    try {
      // No agentMode on the input or the runtime: JEVC_AGENT is blank, so the preference decides.
      await runtime.startSession({ sessionId: "sess-settings", repoId: "repo-test", repoPath: fixtureDir("rate-limit"), prompt: "settings" });
      expect(createJevClient).toHaveBeenCalledTimes(1);
      expect(agentModeFor).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stopSession("sess-settings");
      db.close();
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
```

(`"replay"` keeps the session off Codex and the scripted mock; the preference only offers auto, codex and mock, but `agentModeFor` returns any `AgentMode`.)

- [ ] **Step 2: Run to verify failure**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/agent-mode.test.ts src/shared/prefs.test.ts src/main/ipc.test.ts src/main/pipeline/pipeline-runtime.test.ts`
Expected: FAIL (missing module and fields).

- [ ] **Step 3: Implement**

`agent-mode.ts`:

```ts
import type { AgentMode } from "./types.js";

const MODES: readonly string[] = ["codex", "mock", "auto", "replay"];

/** The session input or runtime option wins, then JEVC_AGENT, then the Settings page preference, then auto. */
export function chooseAgentMode(
  explicit: AgentMode | undefined,
  envValue: string | undefined,
  preference: AgentMode | undefined,
): AgentMode {
  if (explicit !== undefined) return explicit;
  if (envValue !== undefined && MODES.includes(envValue)) return envValue as AgentMode;
  return preference ?? "auto";
}
```

`pipeline-runtime.ts`: replace the body of `resolveAgentMode` with `return chooseAgentMode(mode, process.env["JEVC_AGENT"], this.opts.agentModeFor?.());`, and the Jev client line with `client: this.opts.jevClient ?? this.opts.createJevClient?.() ?? createJevClient(),`. `types.ts` `PipelineRuntimeOptions` gains:

```ts
  /** The Settings page's agent backend; JEVC_AGENT and an explicit agentMode still win (agent-mode.ts). */
  agentModeFor?: () => AgentMode | undefined;
  /** Builds each session's Jev client (index.ts reads the saved TypeSafe key and the Jev client preference). */
  createJevClient?: () => JevClient;
```

`prefs.ts`: add the option lists, keys, fields (defaults `"auto"`), `normalizeAgentBackend` / `normalizeJevClient` (like `normalizeModel`), extend `readAgentPreferences` and `applyPreferencesPatch`, and:

```ts
const AGENT_ENV_VALUES = ["mock", "codex", "auto", "replay"];
export function agentBackendOverride(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env["JEVC_AGENT"];
  return value !== undefined && AGENT_ENV_VALUES.includes(value) ? value : undefined;
}
export function jevClientOverride(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env["JEVC_JEV_CLIENT"];
  return value === "typesafe" || value === "degrade" ? value : undefined;
}
export function jevClientEnvValue(option: JevClientOption): "typesafe" | "degrade" | undefined {
  return option === "typesafe" ? "typesafe" : option === "offline" ? "degrade" : undefined;
}
```

`local-channels.ts`: `AgentPreferencesSchema` gains `agentBackend: z.enum(AGENT_BACKEND_OPTIONS)` and `jevClient: z.enum(JEV_CLIENT_OPTIONS)`; `PreferencesSetPayloadSchema` gains both as optional and its refine checks them too; `PreferencesUpdatedPayloadSchema` gains `agentBackendOverride: z.string().max(32).optional()` and `jevClientOverride: z.string().max(32).optional()`.

`ipc.ts`: `IpcDeps.env?`; rename `withNarratorAvailability` to `preferencesView` and add the overrides:

```ts
  const preferencesView = (prefs: AgentPreferences): PreferencesView => {
    const env = deps.env ?? {};
    const backend = agentBackendOverride(env);
    const jev = jevClientOverride(env);
    return {
      ...prefs,
      ...(deps.narrator === undefined ? {} : { narratorAvailability: deps.narrator.availability() }),
      ...(backend === undefined ? {} : { agentBackendOverride: backend }),
      ...(jev === undefined ? {} : { jevClientOverride: jev }),
    };
  };
```

and in `preferences:set` also `deps.db.setPreference(AGENT_BACKEND_PREF_KEY, next.agentBackend); deps.db.setPreference(JEV_CLIENT_PREF_KEY, next.jevClient);`. Update Task 3's `secretsCall` to use `preferencesView`.

`index.ts`: pass `env: process.env` to `registerIpcHandlers`, and to `new PipelineRuntime({...})`:

```ts
import { createJevClient } from "@jevcode/jev-router";
import { jevClientEnvValue } from "../shared/prefs.js";

    agentModeFor: () => readAgentPreferences((key) => openedDb.getPreference(key)).agentBackend,
    createJevClient: () =>
      createJevClient({
        env: () => ({
          TYPESAFE_API_KEY: secrets.active("TYPESAFE_API_KEY") ?? undefined,
          JEVC_JEV_CLIENT:
            process.env["JEVC_JEV_CLIENT"] ?? jevClientEnvValue(readAgentPreferences((key) => openedDb.getPreference(key)).jevClient),
          TYPESAFE_BASE_URL: process.env["TYPESAFE_BASE_URL"],
          TYPESAFE_DEFAULT_MODEL: process.env["TYPESAFE_DEFAULT_MODEL"],
        }),
      }),
```

- [ ] **Step 4: Run the tests**

Same command as Step 2. Expected: PASS. Then `perl -e 'alarm 590; exec @ARGV' pnpm --filter jevcode-desktop test` in the background, poll until done: expect all desktop tests to pass (fix any test that pins the exact `AgentPreferences` shape by adding the two `"auto"` fields).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec tsc --noEmit -p tsconfig.json
perl -e 'alarm 120; exec @ARGV' pnpm exec eslint apps/desktop/src/shared/prefs.ts apps/desktop/src/shared/local-channels.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/pipeline/agent-mode.ts apps/desktop/src/main/pipeline/types.ts apps/desktop/src/main/pipeline/pipeline-runtime.ts apps/desktop/src/main/index.ts
git add apps/desktop/src/shared/prefs.ts apps/desktop/src/shared/prefs.test.ts apps/desktop/src/shared/prefs-ipc.test.ts apps/desktop/src/shared/local-channels.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/pipeline/agent-mode.ts apps/desktop/src/main/pipeline/agent-mode.test.ts apps/desktop/src/main/pipeline/types.ts apps/desktop/src/main/pipeline/pipeline-runtime.ts apps/desktop/src/main/pipeline/pipeline-runtime.test.ts apps/desktop/src/main/index.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): agent backend and Jev client preferences, with environment overrides, for new sessions"
```

---

### Task 6: The Settings page

**Files:**
- Create: `apps/desktop/src/renderer/settings/SettingsPage.tsx`, `apps/desktop/src/renderer/settings/KeysSection.tsx`, `apps/desktop/src/renderer/settings/FeaturesSection.tsx`, `apps/desktop/src/renderer/settings/settings-format.ts`
- Create tests: `apps/desktop/src/renderer/settings/settings-format.test.ts`, `apps/desktop/src/renderer/settings/keys-section.test.tsx`, `apps/desktop/src/renderer/settings/features-section.test.tsx`, `apps/desktop/src/renderer/settings/settings-route.test.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/components/glyph.tsx`, `apps/desktop/src/renderer/components/narrator-format.ts` + `narrator-format.test.ts`, `apps/desktop/src/renderer/styles.css`
- Delete: `apps/desktop/src/renderer/components/AgentSettings.tsx`, `apps/desktop/src/renderer/components/agent-settings.test.tsx` (their assertions move to `features-section.test.tsx`)

**Interfaces:**
- Consumes: Task 3 `bridge.secrets.*`, `bridge.onSecretsUpdated`; Task 5 `PreferencesView` fields and `AGENT_BACKEND_OPTIONS`, `JEV_CLIENT_OPTIONS`; existing `bridge.prefs`, `narratorSettingNote`.
- Produces: `SettingsPage({ prefs, onSetPrefs, onClose }: SettingsPageProps)`; DOM hooks for the smoke: `[data-settings-open]` (sidebar row), `[data-settings-page]` (page root), `[data-settings-back]` (Back button).

- [ ] **Step 1: Write the pure formatter and its tests**

```ts
// apps/desktop/src/renderer/settings/settings-format.ts
import type { ApiKeyName, KeyStatus, KeyTestResult } from "../../shared/secrets.js";

export function keyTitle(name: ApiKeyName): string {
  return name === "ANTHROPIC_API_KEY" ? "Anthropic" : "TypeSafe";
}

export function keyPurpose(name: ApiKeyName): string {
  return name === "ANTHROPIC_API_KEY" ? "Narrator descriptions and stories" : "Jev decisions";
}

export function keyStatusLine(status: KeyStatus): string {
  if (status.unreadable && status.source !== "app") {
    return status.source === "env"
      ? `A saved key could not be read; save it again · using the environment key …${status.last4 ?? ""}`
      : "A saved key could not be read; save it again";
  }
  switch (status.source) {
    case "app":
      return status.envAlsoSet
        ? `Saved in app · …${status.last4 ?? ""} — overrides the environment key`
        : `Saved in app · …${status.last4 ?? ""}`;
    case "env":
      return `From environment · …${status.last4 ?? ""}`;
    case "none":
      return "Not set";
  }
}

export function keyTestLine(result: KeyTestResult): string {
  switch (result.result) {
    case "ok":
      return "Key works";
    case "unauthorized":
      return "Anthropic rejected this key";
    case "unreachable":
      return "Could not reach Anthropic";
    case "error":
      return result.status === undefined ? "The check failed" : `The check failed (HTTP ${result.status})`;
  }
}

export function overrideNote(variable: string, value: string): string {
  return `Set by ${variable}=${value} (environment)`;
}
```

```ts
// apps/desktop/src/renderer/settings/settings-format.test.ts
import { describe, expect, it } from "vitest";

import { keyStatusLine, keyTestLine, overrideNote } from "./settings-format.js";

const base = { name: "ANTHROPIC_API_KEY", set: true, last4: "a1b2", envAlsoSet: false, unreadable: false } as const;

describe("settings format", () => {
  it("describes each key source", () => {
    expect(keyStatusLine({ ...base, source: "app" })).toBe("Saved in app · …a1b2");
    expect(keyStatusLine({ ...base, source: "app", envAlsoSet: true })).toBe("Saved in app · …a1b2 — overrides the environment key");
    expect(keyStatusLine({ ...base, source: "env" })).toBe("From environment · …a1b2");
    expect(keyStatusLine({ ...base, set: false, source: "none", last4: null })).toBe("Not set");
    expect(keyStatusLine({ ...base, set: false, source: "none", last4: null, unreadable: true })).toBe("A saved key could not be read; save it again");
  });

  it("words test results and overrides", () => {
    expect(keyTestLine({ result: "ok" })).toBe("Key works");
    expect(keyTestLine({ result: "error", status: 500 })).toBe("The check failed (HTTP 500)");
    expect(overrideNote("JEVC_AGENT", "mock")).toBe("Set by JEVC_AGENT=mock (environment)");
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/settings/settings-format.test.ts` → FAIL first (module missing), PASS after writing the module. Commit both:

```bash
git add apps/desktop/src/renderer/settings/settings-format.ts apps/desktop/src/renderer/settings/settings-format.test.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): Settings page wording for key sources, checks and overrides"
```

- [ ] **Step 2: Write the failing KeysSection tests**

```tsx
// apps/desktop/src/renderer/settings/keys-section.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretsView } from "../../shared/secrets.js";
import { KeysSection } from "./KeysSection.js";

const SECRET = "sk-ant-api03-secret-value-9f3a";
const none = (canSave = true): SecretsView => ({
  canSave,
  fileUnreadable: false,
  keys: [
    { name: "ANTHROPIC_API_KEY", set: false, source: "none", last4: null, envAlsoSet: false, unreadable: false },
    { name: "TYPESAFE_API_KEY", set: false, source: "none", last4: null, envAlsoSet: false, unreadable: false },
  ],
});
const saved: SecretsView = { ...none(), keys: [{ ...none().keys[0]!, set: true, source: "app", last4: "9f3a" }, none().keys[1]!] };

afterEach(cleanup);

function api(overrides: Partial<Parameters<typeof KeysSection>[0]["api"]> = {}) {
  return {
    set: vi.fn(async () => saved),
    remove: vi.fn(async () => none()),
    test: vi.fn(async () => ({ result: "ok" as const })),
    ...overrides,
  };
}

describe("KeysSection", () => {
  it("adds a key without ever rendering it, and saves it trimmed (Review Focus 1)", async () => {
    const keys = api();
    render(<KeysSection view={none()} api={keys} />);
    const row = screen.getByRole("group", { name: /Anthropic/ });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    const field = within(row).getByLabelText("Anthropic key") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(field, { target: { value: `${SECRET}\n` } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(keys.set).toHaveBeenCalledWith("ANTHROPIC_API_KEY", `${SECRET}\n`));
    await waitFor(() => expect(screen.queryByLabelText("Anthropic key")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("shows a refusal without repeating the value", async () => {
    const keys = api({ set: vi.fn(async () => Promise.reject(new Error("A key must be 1 to 512 characters with no spaces or control characters."))) });
    render(<KeysSection view={none()} api={keys} />);
    const row = screen.getByRole("group", { name: /Anthropic/ });
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    fireEvent.change(within(row).getByLabelText("Anthropic key"), { target: { value: "has space" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await screen.findByText(/no spaces or control characters/);
    expect(document.body.textContent).not.toContain("has space");
  });

  it("offers Replace, Remove and Test for a saved key, and reports the check", async () => {
    const keys = api();
    render(<KeysSection view={saved} api={keys} />);
    const row = screen.getByRole("group", { name: /Anthropic/ });
    expect(within(row).getByText("Saved in app · …9f3a")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Test" }));
    await within(row).findByText("Key works");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(keys.remove).toHaveBeenCalledWith("ANTHROPIC_API_KEY"));
    expect(within(screen.getByRole("group", { name: /TypeSafe/ })).queryByRole("button", { name: "Test" })).toBeNull();
  });

  it("disables saving where the OS cannot encrypt, and says why", () => {
    render(<KeysSection view={none(false)} api={api()} />);
    expect((screen.getAllByRole("button", { name: "Add" })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("This system cannot encrypt saved keys; set the key in the environment instead.")).toBeTruthy();
  });

  it("offers Replace but no Remove for an environment key", () => {
    const fromEnv: SecretsView = { ...none(), keys: [{ ...none().keys[0]!, set: true, source: "env", last4: "c3d4" }, none().keys[1]!] };
    render(<KeysSection view={fromEnv} api={api()} />);
    const anthropic = screen.getByRole("group", { name: /Anthropic/ });
    expect(within(anthropic).getByText("From environment · …c3d4")).toBeTruthy();
    expect(within(anthropic).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(anthropic).getByRole("button", { name: "Replace" })).toBeTruthy();
  });

  it("disables Test while no Anthropic key is active", () => {
    render(<KeysSection view={none()} api={api()} />);
    const anthropic = screen.getByRole("group", { name: /Anthropic/ });
    expect((within(anthropic).getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/settings/keys-section.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Write KeysSection**

```tsx
// apps/desktop/src/renderer/settings/KeysSection.tsx
import { useId, useState } from "react";

import { CANNOT_ENCRYPT_MESSAGE } from "../../shared/secrets.js";
import type { ApiKeyName, KeyStatus, KeyTestResult, SecretsView } from "../../shared/secrets.js";
import { Glyph } from "../components/glyph.js";
import { keyPurpose, keyStatusLine, keyTestLine, keyTitle } from "./settings-format.js";

export interface KeysApi {
  set(name: ApiKeyName, value: string): Promise<SecretsView>;
  remove(name: ApiKeyName): Promise<SecretsView>;
  test(name: "ANTHROPIC_API_KEY"): Promise<KeyTestResult>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save the key.";
}

function KeyRow({ status, canSave, api }: { status: KeyStatus; canSave: boolean; api: KeysApi }) {
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const title = keyTitle(status.name);

  const save = async () => {
    try {
      await api.set(status.name, value);
      setValue("");
      setEditing(false);
      setMessage(null);
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  return (
    <div className="settings-key" role="group" aria-labelledby={titleId}>
      <div className="settings-key-head">
        <Glyph name="key" />
        <span id={titleId} className="settings-key-title">
          {title}
        </span>
        <span className="settings-key-purpose">{keyPurpose(status.name)}</span>
      </div>
      <p className="settings-key-status" aria-live="polite">
        {keyStatusLine(status)}
      </p>
      {editing ? (
        <form
          className="settings-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${title} key`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit" className="settings-button primary" disabled={value.trim() === ""}>
            Save
          </button>
          <button
            type="button"
            className="settings-button"
            onClick={() => {
              setValue("");
              setEditing(false);
              setMessage(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="settings-key-actions">
          <button type="button" className="settings-button" disabled={!canSave} onClick={() => setEditing(true)}>
            {status.set ? "Replace" : "Add"}
          </button>
          {status.source === "app" ? (
            <button
              type="button"
              className="settings-button"
              onClick={() => void api.remove(status.name).catch((error: unknown) => setMessage(errorText(error)))}
            >
              Remove
            </button>
          ) : null}
          {status.name === "ANTHROPIC_API_KEY" ? (
            <button
              type="button"
              className="settings-button"
              disabled={!status.set || testing}
              onClick={() => {
                setTesting(true);
                void api
                  .test("ANTHROPIC_API_KEY")
                  .then((result) => setMessage(keyTestLine(result)))
                  .catch(() => setMessage("The check failed"))
                  .finally(() => setTesting(false));
              }}
            >
              Test
            </button>
          ) : null}
        </div>
      )}
      {message !== null ? <p className="settings-key-message" role="status">{message}</p> : null}
    </div>
  );
}

export function KeysSection({ view, api }: { view: SecretsView; api: KeysApi }) {
  return (
    <section className="settings-section" aria-labelledby="settings-keys-title">
      <h2 id="settings-keys-title">API keys</h2>
      {!view.canSave ? <p className="settings-note">{CANNOT_ENCRYPT_MESSAGE}</p> : null}
      {view.fileUnreadable ? <p className="settings-note">Saved keys could not be read; save them again.</p> : null}
      {view.keys.map((status) => (
        <KeyRow key={status.name} status={status} canSave={view.canSave} api={api} />
      ))}
    </section>
  );
}
```

Add a `key` glyph to `glyph.tsx` `PATHS` (a 16×16 stroke key: `"M10.5 2.5a3 3 0 1 1 0 6a3 3 0 0 1 0-6M8.4 7.6L2.5 13.5M4.5 11.5l1.5 1.5M6 10l1.5 1.5"`) and a `back` glyph (`"M10 3.5L5.5 8l4.5 4.5"`); extend `GlyphName` if it is a union of the keys.

Run the KeysSection tests → PASS. Commit:

```bash
git add apps/desktop/src/renderer/settings/KeysSection.tsx apps/desktop/src/renderer/settings/keys-section.test.tsx apps/desktop/src/renderer/components/glyph.tsx
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): the Settings page's API keys section"
```

- [ ] **Step 4: Write the failing FeaturesSection tests** (move the narrator-note assertions from `agent-settings.test.tsx`)

```tsx
// apps/desktop/src/renderer/settings/features-section.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_PREFERENCES } from "../../shared/prefs.js";
import type { PreferencesView } from "../../shared/prefs.js";
import { FeaturesSection } from "./FeaturesSection.js";

afterEach(cleanup);

const prefs = (extra: Partial<PreferencesView> = {}): PreferencesView => ({ ...DEFAULT_AGENT_PREFERENCES, ...extra });

describe("FeaturesSection", () => {
  it("turns the narrator off and on, with its disclosure note", () => {
    const onSet = vi.fn();
    render(<FeaturesSection prefs={prefs({ narratorAvailability: "on" })} onSet={onSet} />);
    const toggle = screen.getByRole("checkbox", { name: "Explain with a model" });
    expect(screen.getByText(/Sends to Claude Haiku/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(onSet).toHaveBeenCalledWith({ explainWithModel: false });
  });

  it("sets the agent backend and Jev client, marked as applying to new sessions", () => {
    const onSet = vi.fn();
    render(<FeaturesSection prefs={prefs()} onSet={onSet} />);
    fireEvent.change(screen.getByLabelText("Agent backend"), { target: { value: "mock" } });
    fireEvent.change(screen.getByLabelText("Jev decisions"), { target: { value: "offline" } });
    expect(onSet).toHaveBeenCalledWith({ agentBackend: "mock" });
    expect(onSet).toHaveBeenCalledWith({ jevClient: "offline" });
    expect(screen.getAllByText("Applies to new sessions")).toHaveLength(2);
  });

  it("disables a control that the environment overrides, and says so", () => {
    render(<FeaturesSection prefs={prefs({ agentBackendOverride: "mock", jevClientOverride: "degrade", narratorAvailability: "off_env" })} onSet={vi.fn()} />);
    expect((screen.getByLabelText("Agent backend") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("Set by JEVC_AGENT=mock (environment)")).toBeTruthy();
    expect((screen.getByLabelText("Jev decisions") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("Set by JEVC_JEV_CLIENT=degrade (environment)")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Explain with a model" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("keeps the Codex model, reasoning effort and usage budget", () => {
    const onSet = vi.fn();
    render(<FeaturesSection prefs={prefs()} onSet={onSet} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });
    fireEvent.change(screen.getByLabelText("Reasoning"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Usage budget unknown" }));
    expect(onSet).toHaveBeenCalledWith({ model: "gpt-5.6-sol" });
    expect(onSet).toHaveBeenCalledWith({ reasoningEffort: "high" });
    expect(onSet).toHaveBeenCalledWith({ usageBudgetFraction: "0.40" });
  });
});
```

Run → FAIL (module missing).

- [ ] **Step 5: Write FeaturesSection** (the model, reasoning and budget controls are the ones in `AgentSettings.tsx` today; copy their markup, then add the three rows below)

```tsx
// apps/desktop/src/renderer/settings/FeaturesSection.tsx
import { AGENT_BACKEND_OPTIONS, AGENT_MODEL_OPTIONS, JEV_CLIENT_OPTIONS, REASONING_EFFORT_OPTIONS } from "../../shared/prefs.js";
import type { AgentBackendOption, AgentModelOption, AgentPreferencesPatch, JevClientOption, PreferencesView, ReasoningEffortOption } from "../../shared/prefs.js";
import type { NarratorAvailability } from "../../shared/narrator-log.js";
import { narratorSettingNote } from "../components/narrator-format.js";
import { overrideNote } from "./settings-format.js";

const BACKEND_LABEL: Record<AgentBackendOption, string> = { auto: "Auto (Codex if installed)", codex: "Codex", mock: "Mock (scripted)" };
const JEV_LABEL: Record<JevClientOption, string> = { auto: "Auto (TypeSafe with a key)", typesafe: "TypeSafe", offline: "Offline (rule-based)" };

export function FeaturesSection({ prefs, onSet }: { prefs: PreferencesView; onSet: (patch: AgentPreferencesPatch) => void }) {
  const availability: NarratorAvailability = prefs.narratorAvailability ?? (prefs.explainWithModel ? "on" : "off_setting");
  const budgetUnknown = prefs.usageBudgetFraction === null;
  const budgetPercent = budgetUnknown ? null : Math.round(Number(prefs.usageBudgetFraction) * 100);
  return (
    <section className="settings-section" aria-labelledby="settings-features-title">
      <h2 id="settings-features-title">Features</h2>

      <div className="settings-row">
        <label className="settings-switch">
          <input
            type="checkbox"
            checked={prefs.explainWithModel}
            disabled={availability === "off_env"}
            aria-describedby="settings-narrator-note"
            onChange={(event) => onSet({ explainWithModel: event.target.checked })}
          />
          <span>Explain with a model</span>
        </label>
        <p id="settings-narrator-note" className="settings-note">
          {narratorSettingNote(availability)}
        </p>
      </div>

      <div className="settings-row">
        <label htmlFor="settings-backend">Agent backend</label>
        <select
          id="settings-backend"
          value={prefs.agentBackend}
          disabled={prefs.agentBackendOverride !== undefined}
          onChange={(event) => onSet({ agentBackend: event.target.value as AgentBackendOption })}
        >
          {AGENT_BACKEND_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {BACKEND_LABEL[option]}
            </option>
          ))}
        </select>
        <p className="settings-note">
          {prefs.agentBackendOverride !== undefined ? overrideNote("JEVC_AGENT", prefs.agentBackendOverride) : "Applies to new sessions"}
        </p>
      </div>

      <div className="settings-row">
        <label htmlFor="settings-jev">Jev decisions</label>
        <select
          id="settings-jev"
          value={prefs.jevClient}
          disabled={prefs.jevClientOverride !== undefined}
          onChange={(event) => onSet({ jevClient: event.target.value as JevClientOption })}
        >
          {JEV_CLIENT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {JEV_LABEL[option]}
            </option>
          ))}
        </select>
        <p className="settings-note">
          {prefs.jevClientOverride !== undefined ? overrideNote("JEVC_JEV_CLIENT", prefs.jevClientOverride) : "Applies to new sessions"}
        </p>
      </div>

      <div className="settings-row">
        <label htmlFor="settings-model">Model</label>
        <select id="settings-model" value={prefs.model} onChange={(event) => onSet({ model: event.target.value as AgentModelOption })}>
          {AGENT_MODEL_OPTIONS.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <label htmlFor="settings-reasoning">Reasoning</label>
        <select
          id="settings-reasoning"
          value={prefs.reasoningEffort}
          onChange={(event) => onSet({ reasoningEffort: event.target.value as ReasoningEffortOption })}
        >
          {REASONING_EFFORT_OPTIONS.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <span>Usage budget</span>
        <label className="settings-inline">
          <input
            type="checkbox"
            aria-label="Usage budget unknown"
            checked={budgetUnknown}
            onChange={(event) => onSet({ usageBudgetFraction: event.target.checked ? null : "0.40" })}
          />
          unknown
        </label>
        <input
          className="settings-slider"
          type="range"
          min={0}
          max={100}
          step={5}
          aria-label="Usage budget"
          value={budgetPercent ?? 40}
          disabled={budgetUnknown}
          onChange={(event) => onSet({ usageBudgetFraction: (Number(event.target.value) / 100).toFixed(2) })}
        />
        <span className="settings-note">{budgetUnknown ? "unknown (assumes 40%)" : `${budgetPercent}%`}</span>
      </div>
    </section>
  );
}
```

Update `narrator-format.ts`: `off_no_key` note → "No Anthropic key is set (add one under Settings → API keys), so labels stay rule-based. Nothing leaves this machine."; `narratorAvailabilityLabel`: `off_setting` → "Off in Settings", `off_no_key` → "Off · no Anthropic key". Update `narrator-format.test.ts` to the new strings.

Run the FeaturesSection and narrator-format tests → PASS. Commit:

```bash
git add apps/desktop/src/renderer/settings/FeaturesSection.tsx apps/desktop/src/renderer/settings/features-section.test.tsx apps/desktop/src/renderer/components/narrator-format.ts apps/desktop/src/renderer/components/narrator-format.test.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): the Settings page's features section"
```

- [ ] **Step 6: Write the failing route tests**

```tsx
// apps/desktop/src/renderer/settings/settings-route.test.tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_PREFERENCES } from "../../shared/prefs.js";
import { App } from "../App.js";
import { installFakeBridge } from "../test-support/fake-bridge.js";

beforeEach(() => {
  const bridge = installFakeBridge();
  vi.mocked(bridge.api.prefs.get).mockResolvedValue({ ...DEFAULT_AGENT_PREFERENCES });
});
afterEach(cleanup);

async function openSettings(): Promise<{ row: HTMLElement; heading: HTMLElement; workspace: HTMLElement }> {
  render(<App />);
  const row = screen.getByRole("button", { name: "Settings" });
  const workspace = document.querySelector(".workspace-column [data-workspace-slot]") as HTMLElement;
  fireEvent.click(row);
  const heading = await screen.findByRole("heading", { level: 1, name: "Settings" });
  return { row, heading, workspace };
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("Settings route", () => {
  it("opens from the sidebar row, keeps the workspace mounted, and returns focus on Esc", async () => {
    const { row, heading, workspace } = await openSettings();
    expect(document.activeElement).toBe(heading);
    expect(workspace.isConnected).toBe(true);
    expect(workspace.hidden).toBe(true);
    expect(press(heading, { key: "Escape", code: "Escape" }).defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull());
    expect(workspace.hidden).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("opens with Cmd+, and Ctrl+,", async () => {
    render(<App />);
    press(window, { key: ",", metaKey: true });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull());
    press(window, { key: ",", ctrlKey: true });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
  });

  it("keeps keys aimed at the page body away from the hidden viewer, but lets Tab move focus", async () => {
    await openSettings();
    // The viewer's KeyboardLayer treats <body> targets as its own and skips prevented events.
    expect(press(document.body, { key: "j", code: "KeyJ" }).defaultPrevented).toBe(true);
    expect(press(document.body, { key: "Tab", code: "Tab" }).defaultPrevented).toBe(false);
    expect(press(document.body, { key: "Escape", code: "Escape" }).defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull());
  });
});
```

Run → FAIL (no "Settings" row).

- [ ] **Step 7: Write SettingsPage and the route**

```tsx
// apps/desktop/src/renderer/settings/SettingsPage.tsx
import { useEffect, useRef, useState } from "react";

import type { AgentPreferencesPatch, PreferencesView } from "../../shared/prefs.js";
import type { SecretsView } from "../../shared/secrets.js";
import { getBridge } from "../bridge.js";
import { Glyph } from "../components/glyph.js";
import { FeaturesSection } from "./FeaturesSection.js";
import { KeysSection } from "./KeysSection.js";

export interface SettingsPageProps {
  prefs: PreferencesView;
  onSetPrefs: (patch: AgentPreferencesPatch) => void;
  onClose: () => void;
}

export function SettingsPage({ prefs, onSetPrefs, onClose }: SettingsPageProps) {
  const bridge = getBridge();
  const heading = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState<SecretsView | null>(null);

  useEffect(() => {
    heading.current?.focus();
    void bridge.secrets.view().then(setView).catch(() => undefined);
    return bridge.onSecretsUpdated(setView);
  }, [bridge]);

  // Window capture phase runs before the viewer's KeyboardLayer (window, bubble phase), which skips prevented events.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      // The hidden viewer treats keys aimed at <body> as its own; keep them out so Back finds it as it was.
      const target = event.target;
      const atBody = target === null || target === document.body || target === document.documentElement || target === window;
      if (atBody && event.key !== "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <section className="settings-page" data-settings-page="" aria-labelledby="settings-title">
      <header className="settings-header">
        <button type="button" className="settings-back" data-settings-back="" onClick={onClose}>
          <Glyph name="back" />
          Back
        </button>
        <h1 id="settings-title" ref={heading} tabIndex={-1}>
          Settings
        </h1>
      </header>
      {view !== null ? <KeysSection view={view} api={bridge.secrets} /> : null}
      <FeaturesSection prefs={prefs} onSet={onSetPrefs} />
    </section>
  );
}
```

`App.tsx`:
- Remove the `AgentSettings` import and element. Add:

```tsx
const [settingsOpen, setSettingsOpen] = useState(false);
const settingsRow = useRef<HTMLButtonElement>(null);
const closeSettings = useCallback(() => setSettingsOpen(false), []);
// Focus goes back to the Settings row once the page has closed (spec: accessibility).
const settingsWasOpen = useRef(false);
useEffect(() => {
  if (settingsWasOpen.current && !settingsOpen) settingsRow.current?.focus();
  settingsWasOpen.current = settingsOpen;
}, [settingsOpen]);
```

- In the sidebar, in place of `<AgentSettings …/>`:

```tsx
<section className="agent-settings">
  <button
    ref={settingsRow}
    type="button"
    className={`side-row${settingsOpen ? " on" : ""}`}
    data-settings-open=""
    aria-pressed={settingsOpen}
    onClick={() => setSettingsOpen(true)}
  >
    <Glyph name="settings" />
    <span className="side-label">Settings</span>
  </button>
</section>
```

- Extend the existing window `keydown` effect (the Cmd/Ctrl+Shift+J one): `if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === ",") { event.preventDefault(); setSettingsOpen(true); }`.
- In `<main className="workspace-column">`, wrap the existing content (the trace error, `WorkspaceHost`, `TerminalPanel`) in `<div className="workspace-slot" data-workspace-slot="" hidden={settingsOpen}>…</div>`, and add after it:

```tsx
{settingsOpen ? <SettingsPage prefs={prefs} onSetPrefs={(patch) => void bridge.prefs.set(patch)} onClose={closeSettings} /> : null}
```

- Import `useCallback`, `useRef` from react, `Glyph` from `./components/glyph.js` and `SettingsPage` from `./settings/SettingsPage.js`.
- Delete `AgentSettings.tsx` and `agent-settings.test.tsx`.

`styles.css` (host chrome; every selector has a class):

```css
/* The slot keeps the workspace column's flex layout; [hidden] must win over display: contents. */
.workspace-slot { display: contents; }
.workspace-slot[hidden] { display: none; }
.settings-page { flex: 1; overflow: auto; padding: 24px 32px 40px; max-width: 760px; }
.settings-header { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
.settings-header h1 { font-size: 18px; font-weight: 600; color: var(--tv-ink); outline: none; }
.settings-back { align-self: flex-start; display: inline-flex; gap: 4px; align-items: center; color: var(--tv-ink-2); }
.settings-section { display: flex; flex-direction: column; gap: 14px; padding: 16px 0; }
.settings-section + .settings-section { border-top: 1px solid var(--tv-hair); }
.settings-section h2 { font-size: 13px; font-weight: 600; color: var(--tv-ink-2); }
.settings-key { display: grid; gap: 6px; padding: 10px 12px; border-radius: 8px; background: var(--tv-fill); }
.settings-key-head { display: flex; gap: 8px; align-items: baseline; }
.settings-key-title { font-weight: 600; color: var(--tv-ink); }
.settings-key-purpose, .settings-key-status, .settings-note, .settings-key-message { font-size: 12px; color: var(--tv-ink-3); }
.settings-key-actions, .settings-key-form { display: flex; gap: 8px; align-items: center; }
.settings-key-form input { flex: 1; font-family: var(--mono); }
.settings-row { display: grid; grid-template-columns: 160px 1fr; gap: 6px 12px; align-items: center; }
.settings-row .settings-note { grid-column: 2; }
.settings-switch, .settings-inline { display: inline-flex; gap: 8px; align-items: center; }
.settings-button.primary { background: var(--tv-accent); color: var(--tv-panel); }
```

Delete the now-unused `.agent-settings-body`, `.agent-settings-row`, `.budget-*` and `.narrator-note` rules if nothing else uses them (grep first); keep `.agent-settings` (it now wraps the Settings row).

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer` → PASS, including `styles-scope.test.tsx` (every new selector carries a class). `narrator-format.test.ts` is the only other test that names "Agent settings"; Step 5 already updated it.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec tsc --noEmit -p tsconfig.json
perl -e 'alarm 120; exec @ARGV' pnpm exec eslint apps/desktop/src/renderer
git add apps/desktop/src/renderer
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): a Settings page in the main window, opened with Cmd+, or the sidebar, replacing the Agent settings panel"
```

(`git add apps/desktop/src/renderer` stages the two deletions as well; check `git status --short` first so nothing unrelated is staged.)

---

### Task 7: Smoke screenshot, smoke hygiene and the product spec

**Files:**
- Modify: `apps/desktop/src/main/smoke-workspace.ts`, `apps/desktop/src/main/smoke-workspace.test.ts`, `apps/desktop/scripts/smoke-workspace.mjs`, `docs/SPEC.md`

**Interfaces:**
- Consumes: Task 6 DOM hooks `[data-settings-open]`, `[data-settings-page]`, `[data-settings-back]`; Task 4's `JEVCODE_SECRETS_FILE`.
- Produces: `SETTINGS_OPEN_SCRIPT`, `SETTINGS_CLOSE_SCRIPT`, `exerciseSettings(deps, shotsDir): Promise<void>` in `smoke-workspace.ts`; screenshot `main-settings-1440.png`.

- [ ] **Step 1: Write the failing smoke unit test** (append to `smoke-workspace.test.ts`, using the file's existing fake deps)

```ts
it("opens Settings, captures it at 1440 px and closes it", async () => {
  const exec = vi.fn(async (script: string) => {
    if (script === SETTINGS_OPEN_SCRIPT) return { open: true };
    if (script === SETTINGS_CLOSE_SCRIPT) return { open: false };
    return true;
  });
  const capture = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const writeFile = vi.fn();
  const log = vi.fn();
  await exerciseSettings({ exec, capture, writeFile, log }, "/tmp/shots");
  expect(capture).toHaveBeenCalledWith(1440, SHOT_HEIGHT);
  expect(writeFile).toHaveBeenCalledWith(path.join("/tmp/shots", "main-settings-1440.png"), new Uint8Array([1, 2, 3]));
  expect(log).toHaveBeenCalledWith(`SMOKE_SHOT ${path.join("/tmp/shots", "main-settings-1440.png")}`);
  expect(log).toHaveBeenLastCalledWith("SMOKE_SETTINGS open=true closed=true");
});

it("fails clearly when the Settings page does not open", async () => {
  const exec = vi.fn(async () => ({ open: false, timedOut: true }));
  await expect(exerciseSettings({ exec, capture: vi.fn(), writeFile: vi.fn(), log: vi.fn() }, null)).rejects.toThrow("Settings step: the page did not open");
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/smoke-workspace.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
const SETTINGS_WAIT_MS = 5_000;

function pollSettings(wantOpen: boolean): string {
  return `(async () => {
    const until = Date.now() + ${SETTINGS_WAIT_MS};
    const isOpen = () => document.querySelector("[data-settings-page]") !== null;
    while (Date.now() < until) {
      if (isOpen() === ${wantOpen}) return { open: isOpen() };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { open: isOpen(), timedOut: true };
  })()`;
}

export const SETTINGS_OPEN_SCRIPT = `(async () => {
  const row = document.querySelector("[data-settings-open]");
  if (row === null) return { open: false, noRow: true };
  row.click();
  return ${pollSettings(true)};
})()`;

export const SETTINGS_CLOSE_SCRIPT = `(async () => {
  const back = document.querySelector("[data-settings-back]");
  if (back !== null) back.click();
  return ${pollSettings(false)};
})()`;

/** Opens Settings from the sidebar, captures it, and returns to the session. */
export async function exerciseSettings(
  deps: Pick<WorkspaceSmokeDeps, "exec" | "capture" | "writeFile" | "log">,
  shotsDir: string | null,
): Promise<void> {
  const opened = (await deps.exec(SETTINGS_OPEN_SCRIPT)) as { open?: boolean } | null;
  if (opened?.open !== true) throw new Error("Settings step: the page did not open");
  if (shotsDir !== null) {
    const file = path.join(shotsDir, "main-settings-1440.png");
    deps.writeFile(file, await deps.capture(1440, SHOT_HEIGHT));
    deps.log(`SMOKE_SHOT ${file}`);
  }
  const closed = (await deps.exec(SETTINGS_CLOSE_SCRIPT)) as { open?: boolean } | null;
  if (closed?.open !== false) throw new Error("Settings step: the page did not close");
  deps.log("SMOKE_SETTINGS open=true closed=true");
}
```

Call `await exerciseSettings(deps, options.shotsDir);` in `runWorkspaceSmoke` right after `await walkViews(deps);` (the views walk ends on Console). Update the header comment's step list.

The existing full-run test (`describe("runWorkspaceSmoke")`, first case) pins every `SMOKE_` line and every file, so update it with the step:

- In `fake()`'s `exec`, before the `VIEW_KEYS` lookup: `if (script === SETTINGS_OPEN_SCRIPT) return { open: true };` and `if (script === SETTINGS_CLOSE_SCRIPT) return { open: false };` (import both names).
- Append to the expected lines, after `SMOKE_VIEWS …`: `` `SMOKE_SHOT ${path.join("/tmp/shots", "main-settings-1440.png")}` `` and `"SMOKE_SETTINGS open=true closed=true"`.
- Expect the files to be `[...shots, path.join("/tmp/shots", "main-settings-1440.png")]`.

In `scripts/smoke-workspace.mjs`, add to the child `env` block (next to `JEVCODE_DB`): `JEVCODE_SECRETS_FILE: path.join(tmp, "secrets.json"),`, so the smoke never reads the person's saved keys. (Task 4's `SMOKE_SECRET_CRYPTO` already keeps it away from the keychain.)

- [ ] **Step 3: Run the smoke unit tests, then one Electron smoke**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/smoke-workspace.test.ts` → PASS.
Then, with `uptime` load below 10:

```bash
perl -e 'alarm 300; exec @ARGV' pnpm -r build
perl -e 'alarm 300; exec @ARGV' pnpm --filter jevcode-desktop run rebuild
perl -e 'alarm 330; exec @ARGV' node apps/desktop/scripts/smoke-workspace.mjs
perl -e 'alarm 300; exec @ARGV' pnpm --filter jevcode-desktop run rebuild:node
```

Expected: `SMOKE_SETTINGS open=true closed=true` and `WORKSPACE_SMOKE_PASS`. If the 1-minute load is 8 or more (`sysctl -n vm.loadavg`), wait for it to drop first; a loaded machine fails the Console append budget, not this feature. Restore node-pty `build/Release/pty.node` and `spawn-helper` from `prebuilds/<platform-arch>/` after `rebuild:node` (see the implementer rules). Open `main-settings-1440.png` and check: light page, two sections, both keys "Not set" (the temp secrets file is empty and `ANTHROPIC_API_KEY=""`), the narrator toggle disabled with the `JEVCODE_NARRATOR=off` note, the agent backend unlocked or noting `JEVC_AGENT` if the smoke sets it.

- [ ] **Step 4: Update the product spec** (`docs/SPEC.md`)

- §3.7 "Secrets handling" row: add "API keys can be saved on the Settings page; they are encrypted with Electron `safeStorage` (the OS keychain) into `<userData>/secrets.json` (mode 0600). A saved key wins over the environment; the window only ever sees whether a key is set, its source and its last four characters."
- §4.5 channel list: add `secrets:status`, `secrets:set`, `secrets:remove`, `secrets:test` (renderer → main, main window only) and `secrets:updated` (main → renderer).
- §12 item 7: after "With no key, or with the setting off, nothing is sent." add "The key can come from the environment, `.env`, or the Settings page."

- [ ] **Step 5: Run the desktop suite, typecheck, lint, commit**

Run `perl -e 'alarm 590; exec @ARGV' pnpm --filter jevcode-desktop test` in the background and poll until done → PASS. Then:

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop exec tsc --noEmit -p tsconfig.json
perl -e 'alarm 120; exec @ARGV' pnpm exec eslint apps/desktop/src/main/smoke-workspace.ts apps/desktop/src/main/smoke-workspace.test.ts
git add apps/desktop/src/main/smoke-workspace.ts apps/desktop/src/main/smoke-workspace.test.ts apps/desktop/scripts/smoke-workspace.mjs docs/SPEC.md
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "test(desktop): the workspace smoke opens Settings and keeps saved keys out of its run; document saved keys in the product spec"
```
