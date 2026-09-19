export function createHash(): unknown {
  throw new Error("node:crypto is stubbed in the preload bundle");
}

export function randomUUID(): string {
  throw new Error("node:crypto is stubbed in the preload bundle");
}
