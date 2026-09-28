// Node-only helpers, exported as "@jevcode/contracts/node". Never import this file from
// the barrel (src/index.ts): the barrel must stay browser-safe (browser-safety.test.ts).
import { createHash } from "node:crypto";

import type { SymbolKind } from "./evidence.js";

export function symbolId(
  path: string,
  name: string,
  kind: SymbolKind,
  signatureText: string,
): string {
  const hash = createHash("sha1").update(signatureText).digest("hex");
  return `${path}#${name}(${kind})@${hash}`;
}
