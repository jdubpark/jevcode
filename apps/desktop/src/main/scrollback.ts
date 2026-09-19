export class ScrollbackBuffer {
  private readonly lines: string[] = [];
  private partial = "";

  constructor(private readonly maxLines: number) {
    if (!Number.isInteger(maxLines) || maxLines <= 0) {
      throw new RangeError(`maxLines must be a positive integer, got ${maxLines}`);
    }
  }

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.partial += chunk;
    const parts = this.partial.split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.appendLine(line);
    }
  }

  private appendLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  get(max?: number): string[] {
    return max === undefined ? [...this.lines] : this.lines.slice(-max);
  }

  get length(): number {
    return this.lines.length;
  }

  clear(): void {
    this.lines.length = 0;
    this.partial = "";
  }
}
