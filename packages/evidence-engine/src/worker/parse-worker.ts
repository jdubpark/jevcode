import { parentPort } from "node:worker_threads";

import {
  createTreeSitterBackend,
  languageForPath,
} from "./parser.js";

interface ParseRequest {
  id: number;
  filePath: string;
  source: string;
}

interface ParseResponse {
  id: number;
  filePath: string;
  symbols?: unknown[];
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
    response.symbols = language ? backend.parse(request.source, language) : [];
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  port.postMessage(response);
});
