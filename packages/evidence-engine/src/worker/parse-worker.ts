import { parentPort } from "node:worker_threads";

import {
  createTreeSitterBackend,
  languageForPath,
} from "./parser.js";
import type { ImportScan } from "./tree-sitter.js";

interface ParseRequest {
  id: number;
  /** "imports" extracts import specifiers (codebase map); absent means symbols. */
  op?: "symbols" | "imports";
  filePath: string;
  source: string;
}

interface ParseResponse {
  id: number;
  filePath: string;
  symbols?: unknown[];
  imports?: ImportScan;
  error?: string;
}

if (!parentPort) {
  throw new Error("parse-worker must run inside a worker thread");
}

const port = parentPort;
const backend = await createTreeSitterBackend();

port.on("message", (request: ParseRequest) => {
  const response: ParseResponse = { id: request.id, filePath: request.filePath };
  try {
    const language = languageForPath(request.filePath);
    if (request.op === "imports") {
      response.imports = language ? backend.imports(request.source, language) : { specifiers: [], exports: [] };
    } else {
      response.symbols = language ? backend.parse(request.source, language) : [];
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  port.postMessage(response);
});
