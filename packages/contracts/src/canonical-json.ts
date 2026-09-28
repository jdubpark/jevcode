/**
 * Deterministic JSON. Object keys are sorted by UTF-16 code unit order at
 * every depth, properties whose value is `undefined` are dropped, and arrays
 * keep their order. Two values that differ only in key order produce the
 * same string. Fact ids hash this string (packages/semantic-core/src/ids.ts),
 * so a collector-ordered fact and its zod-reordered stored copy share one id.
 * Integer-like keys enumerate in ascending numeric order (an engine rule);
 * the output is still a function of the key set alone.
 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const source = current as Record<string, unknown>;
    // A null prototype keeps an own "__proto__" key as data.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      sorted[key] = source[key];
    }
    return sorted;
  });
  if (text === undefined) {
    throw new TypeError("canonicalJson: value has no JSON representation");
  }
  return text;
}
