const cryptoStub = `
export function createHash() {
  throw new Error("node:crypto createHash is unavailable in the renderer bundle");
}
export function randomUUID() {
  return globalThis.crypto.randomUUID();
}
`;

export function nodeBuiltinStub() {
  return {
    name: "jevcode-node-builtin-stub",
    enforce: "pre" as const,
    resolveId(source: string) {
      if (source.startsWith("node:")) {
        return `\0node-stub:${source}`;
      }
      return null;
    },
    load(id: string) {
      if (id.startsWith("\0node-stub:")) {
        const source = id.slice("\0node-stub:".length);
        if (source === "node:crypto") return cryptoStub;
        return `export default {};`;
      }
      return null;
    },
  };
}
