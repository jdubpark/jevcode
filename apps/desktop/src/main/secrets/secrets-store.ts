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
