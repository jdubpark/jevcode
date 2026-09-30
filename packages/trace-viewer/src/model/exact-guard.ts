import type { z } from "zod";

/**
 * A fast, conservative mirror of a zod (v3) schema for untrusted rows (spec §3.3, §6.4): the guard
 * returns true only when zod would accept the value AND parse it to a deep-equal copy (no unknown
 * keys to strip, no defaults, no transforms). Anything it cannot mirror exactly returns false, and
 * the caller runs the real `safeParse`, which also writes the gap message. So the verdicts and
 * messages stay zod's; the guard only skips zod's per-node allocation on the common valid row.
 */
export type ExactGuard = (value: unknown) => boolean;

interface Def {
  typeName?: string;
  [key: string]: unknown;
}

const REJECT: ExactGuard = () => false;
const GUARDS = new WeakMap<z.ZodTypeAny, ExactGuard>();

function defOf(schema: z.ZodTypeAny): Def {
  return schema._def as Def;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

interface Check {
  kind: string;
  value?: unknown;
  inclusive?: boolean;
}

function stringGuard(def: Def): ExactGuard {
  if (def["coerce"] === true) return REJECT;
  let min = 0;
  let max = Number.POSITIVE_INFINITY;
  for (const check of (def["checks"] ?? []) as Check[]) {
    const n = typeof check.value === "number" ? check.value : Number.NaN;
    if (check.kind === "min") min = Math.max(min, n);
    else if (check.kind === "max") max = Math.min(max, n);
    else if (check.kind === "length") {
      min = Math.max(min, n);
      max = Math.min(max, n);
    } else return REJECT;
  }
  if (Number.isNaN(min) || Number.isNaN(max)) return REJECT;
  return (value) => typeof value === "string" && value.length >= min && value.length <= max;
}

function numberGuard(def: Def): ExactGuard {
  if (def["coerce"] === true) return REJECT;
  const tests: ((n: number) => boolean)[] = [];
  for (const check of (def["checks"] ?? []) as Check[]) {
    const bound = check.value;
    if (check.kind === "int") tests.push(Number.isInteger);
    else if (check.kind === "finite") tests.push(Number.isFinite);
    else if (check.kind === "min" && typeof bound === "number") tests.push(check.inclusive === false ? (n) => n > bound : (n) => n >= bound);
    else if (check.kind === "max" && typeof bound === "number") tests.push(check.inclusive === false ? (n) => n < bound : (n) => n <= bound);
    else return REJECT;
  }
  return (value) => typeof value === "number" && !Number.isNaN(value) && tests.every((test) => test(value));
}

function arrayGuard(def: Def): ExactGuard {
  const item = compile(def["type"] as z.ZodTypeAny);
  const bound = (key: string): number | null => {
    const entry = def[key] as { value?: unknown } | null | undefined;
    return typeof entry?.value === "number" ? entry.value : null;
  };
  // zod checks minLength, maxLength and exactLength independently, so every bound set applies.
  const exact = bound("exactLength");
  const min = Math.max(bound("minLength") ?? 0, exact ?? 0);
  const max = Math.min(bound("maxLength") ?? Number.POSITIVE_INFINITY, exact ?? Number.POSITIVE_INFINITY);
  return (value) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) return false;
    for (const element of value as unknown[]) if (!item(element)) return false;
    return true;
  };
}

function objectGuard(def: Def): ExactGuard {
  // "strip" drops unknown keys and "strict" rejects them; either way only an exact key set is a
  // no-op parse. "passthrough" and a catchall would keep them: leave those to zod.
  const unknownKeys = def["unknownKeys"];
  const catchall = def["catchall"] as z.ZodTypeAny | undefined;
  if ((unknownKeys !== "strip" && unknownKeys !== "strict") || (catchall !== undefined && defOf(catchall).typeName !== "ZodNever")) {
    return REJECT;
  }
  const shape = (def["shape"] as () => Record<string, z.ZodTypeAny>)();
  const fields = Object.entries(shape).map(([key, schema]) => [key, compile(schema)] as const);
  const known = new Set(Object.keys(shape));
  return (value) => {
    if (!isPlainObject(value)) return false;
    for (const key of Object.keys(value)) if (!known.has(key)) return false;
    for (const [key, guard] of fields) if (!guard(value[key])) return false;
    return true;
  };
}

function recordGuard(def: Def): ExactGuard {
  const keyType = def["keyType"] as z.ZodTypeAny;
  const keyDef = defOf(keyType);
  if (keyDef.typeName !== "ZodString" || ((keyDef["checks"] ?? []) as unknown[]).length > 0 || keyDef["coerce"] === true) return REJECT;
  const item = compile(def["valueType"] as z.ZodTypeAny);
  return (value) => {
    if (!isPlainObject(value)) return false;
    for (const key of Object.keys(value)) {
      // zod never copies a "__proto__" key into its output.
      if (key === "__proto__" || !item(value[key])) return false;
    }
    return true;
  };
}

function discriminatedUnionGuard(def: Def): ExactGuard {
  const discriminator = def["discriminator"] as string;
  const options = new Map<unknown, ExactGuard>();
  for (const [tag, schema] of def["optionsMap"] as Map<unknown, z.ZodTypeAny>) options.set(tag, compile(schema));
  return (value) => {
    if (!isPlainObject(value)) return false;
    const option = options.get(value[discriminator]);
    return option !== undefined && option(value);
  };
}

function build(schema: z.ZodTypeAny): ExactGuard {
  const def = defOf(schema);
  switch (def.typeName) {
    case "ZodString":
      return stringGuard(def);
    case "ZodNumber":
      return numberGuard(def);
    case "ZodBoolean":
      return (value) => typeof value === "boolean";
    case "ZodNull":
      return (value) => value === null;
    case "ZodUnknown":
    case "ZodAny":
      return () => true;
    case "ZodLiteral": {
      const literal = def["value"];
      return typeof literal === "object" && literal !== null ? REJECT : (value) => value === literal;
    }
    case "ZodEnum": {
      const values = new Set(def["values"] as readonly string[]);
      return (value) => typeof value === "string" && values.has(value);
    }
    case "ZodOptional": {
      const inner = compile(def["innerType"] as z.ZodTypeAny);
      return (value) => value === undefined || inner(value);
    }
    case "ZodNullable": {
      const inner = compile(def["innerType"] as z.ZodTypeAny);
      return (value) => value === null || inner(value);
    }
    case "ZodArray":
      return arrayGuard(def);
    case "ZodObject":
      return objectGuard(def);
    case "ZodRecord":
      return recordGuard(def);
    case "ZodDiscriminatedUnion":
      return discriminatedUnionGuard(def);
    default:
      // Effects (refine, transform, preprocess), defaults, catch, unions, lazy, tuples, ...: zod decides.
      return REJECT;
  }
}

function compile(schema: z.ZodTypeAny): ExactGuard {
  const cached = GUARDS.get(schema);
  if (cached !== undefined) return cached;
  const guard = build(schema);
  GUARDS.set(schema, guard);
  return guard;
}

/** The exact guard for a schema, compiled once per schema object. */
export function exactGuard(schema: z.ZodTypeAny): ExactGuard {
  return compile(schema);
}
