// Test-only: random overview seeds for the Map layout properties. Excluded from the build.
import fc from "fast-check";

import { ROLES, type Role } from "@jevcode/contracts";

import type { ComponentSeed, OverviewSeed } from "./overview-builder.js";

const ROOTS = Array.from({ length: 40 }, (_, index) => `pkg/c${String(index).padStart(2, "0")}`);
/** Few names, so name ties are common and the id tie-break is exercised. */
const NAMES = ["alpha", "beta", "gamma", "delta"] as const;

interface RawComponent { rootPath: string; role: Role; version: number; externals: number; name: string }

const arbComponent: fc.Arbitrary<RawComponent> = fc.record({
  rootPath: fc.constantFrom(...ROOTS),
  role: fc.constantFrom(...ROLES),
  version: fc.nat(2),
  externals: fc.nat(4),
  name: fc.constantFrom(...NAMES),
});

function seedOf(components: readonly RawComponent[], raw: readonly { from: number; to: number; count: number }[]): OverviewSeed {
  const edges: { from: string; to: string; count: number }[] = [];
  const seen = new Set<string>();
  for (const edge of raw) {
    const from = components[edge.from];
    const to = components[edge.to];
    if (from === undefined || to === undefined || from.rootPath === to.rootPath) continue;
    const key = `${from.rootPath}>${to.rootPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: from.rootPath, to: to.rootPath, count: edge.count });
  }
  const externals = components.flatMap((component, index) =>
    Array.from({ length: component.externals }, (_, k) => ({
      name: `ext-${(index * 7 + k) % 9}`,
      usedBy: [{ rootPath: component.rootPath, count: k + 1 }],
    })),
  );
  return {
    components: components.map(({ rootPath, role, version, name }) => ({ rootPath, role, version, name })),
    edges,
    externals,
  };
}

export function arbOverviewSeed(options: { maxComponents?: number } = {}): fc.Arbitrary<OverviewSeed> {
  const max = options.maxComponents ?? 24;
  return fc.uniqueArray(arbComponent, { maxLength: max, size: "medium", selector: (component) => component.rootPath }).chain((components) => {
    const n = components.length;
    const edges =
      n < 2
        ? fc.constant<{ from: number; to: number; count: number }[]>([])
        : fc.array(fc.record({ from: fc.nat(n - 1), to: fc.nat(n - 1), count: fc.integer({ min: 1, max: 60 }) }), { maxLength: 3 * n, size: "medium" });
    return edges.map((raw) => seedOf(components, raw));
  });
}

/** A later snapshot of the same repo: some components dropped, some re-roled (and re-hashed), up to 4 added from unused roots. */
export function arbOverviewSuccessor(seed: OverviewSeed): fc.Arbitrary<OverviewSeed> {
  const used = new Set(seed.components.map((component) => component.rootPath));
  const free = ROOTS.filter((root) => !used.has(root));
  const n = seed.components.length;
  return fc
    .record({
      // About 80% of components are kept and 20% re-roled, so most cards keep their place and their edges survive.
      keep: fc.array(fc.nat(4).map((value) => value > 0), { minLength: n, maxLength: n }),
      reRole: fc.array(
        fc.oneof({ weight: 4, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: fc.constantFrom(...ROLES) }),
        { minLength: n, maxLength: n },
      ),
      added: fc.subarray(free, { maxLength: 4 }),
      addedRoles: fc.array(fc.constantFrom(...ROLES), { minLength: 4, maxLength: 4 }),
      count: fc.integer({ min: 1, max: 30 }),
    })
    .map(({ keep, reRole, added, addedRoles, count }) => {
      const components: ComponentSeed[] = [];
      seed.components.forEach((component, index) => {
        if (keep[index] === false) return;
        const role = reRole[index];
        components.push(role === undefined ? component : { ...component, role, version: (component.version ?? 0) + 1 });
      });
      added.forEach((rootPath, index) => components.push({ rootPath, role: addedRoles[index] ?? "domain", name: "zeta" }));
      const roots = new Set(components.map((component) => component.rootPath));
      const edges = (seed.edges ?? []).filter((edge) => roots.has(edge.from) && roots.has(edge.to)).map((edge) => ({ ...edge }));
      const anchor = components[0];
      for (const rootPath of added) {
        if (anchor !== undefined && anchor.rootPath !== rootPath) edges.push({ from: rootPath, to: anchor.rootPath, count });
      }
      const externals = (seed.externals ?? []).filter((ext) => ext.usedBy.every((use) => roots.has(use.rootPath)));
      return { ...seed, components, edges, externals };
    });
}
