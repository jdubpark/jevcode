import { spawn } from "node-pty";
import type { IPty } from "node-pty";

import { ScrollbackBuffer } from "./scrollback.js";

const SCROLLBACK_MAX_LINES = 100_000;

export interface EnsurePtyOptions {
  cwd: string;
  cols?: number;
  rows?: number;
}

export class TerminalManager {
  private readonly ptys = new Map<string, IPty>();
  private readonly scrollbacks = new Map<string, ScrollbackBuffer>();

  constructor(
    private readonly onData: (sessionId: string, data: string) => void,
  ) {}

  ensure(sessionId: string, options: EnsurePtyOptions): void {
    let pty = this.ptys.get(sessionId);
    if (!pty) {
      pty = spawn("sh", ["-i"], {
        name: "xterm-256color",
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        cwd: options.cwd,
        env: process.env as Record<string, string>,
      });
      pty.onData((data) => {
        this.scrollback(sessionId).push(data);
        this.onData(sessionId, data);
      });
      pty.onExit(() => {
        this.disposeSession(sessionId);
      });
      this.ptys.set(sessionId, pty);
    }
  }

  write(sessionId: string, data: string): void {
    this.ptys.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.ptys.get(sessionId)?.resize(cols, rows);
  }

  scrollback(sessionId: string): ScrollbackBuffer {
    let buffer = this.scrollbacks.get(sessionId);
    if (!buffer) {
      buffer = new ScrollbackBuffer(SCROLLBACK_MAX_LINES);
      this.scrollbacks.set(sessionId, buffer);
    }
    return buffer;
  }

  scrollbackLines(sessionId: string, maxLines?: number): string[] {
    return this.scrollback(sessionId).get(maxLines);
  }

  hasPty(sessionId: string): boolean {
    return this.ptys.has(sessionId);
  }

  disposeSession(sessionId: string): void {
    const pty = this.ptys.get(sessionId);
    if (pty) {
      try {
        pty.kill();
      } catch {
        // already dead
      }
      this.ptys.delete(sessionId);
    }
    this.scrollbacks.delete(sessionId);
  }

  disposeAll(): void {
    for (const sessionId of [...this.ptys.keys()]) {
      this.disposeSession(sessionId);
    }
  }
}
