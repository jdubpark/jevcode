import { symbolId, type SymbolInfo } from "@jevcode/contracts";

export interface SymbolDeltaParts {
  added: SymbolInfo[];
  removed: SymbolInfo[];
  modified: SymbolInfo[];
}

export function symbolKey(symbol: SymbolInfo): string {
  return `${symbol.name}\u0000${symbol.kind}`;
}

export function symbolIdForPath(path: string, symbol: SymbolInfo): string {
  return symbolId(path, symbol.name, symbol.kind, symbol.signature);
}

export function diffSymbols(
  base: readonly SymbolInfo[],
  current: readonly SymbolInfo[],
  path: string,
): SymbolDeltaParts {
  const baseByKey = new Map<string, SymbolInfo>();
  for (const symbol of base) {
    baseByKey.set(symbolKey(symbol), symbol);
  }
  const delta: SymbolDeltaParts = { added: [], removed: [], modified: [] };
  for (const symbol of current) {
    const key = symbolKey(symbol);
    const baseSymbol = baseByKey.get(key);
    if (!baseSymbol) {
      delta.added.push(symbol);
      continue;
    }
    baseByKey.delete(key);
    if (symbolIdForPath(path, baseSymbol) !== symbolIdForPath(path, symbol)) {
      delta.modified.push(symbol);
    }
  }
  delta.removed = [...baseByKey.values()];
  return delta;
}

export function hasDelta(delta: SymbolDeltaParts): boolean {
  return delta.added.length > 0 || delta.removed.length > 0 || delta.modified.length > 0;
}
