import type {
  ArchitectureEdge,
  ArchitectureNode,
  ArchitectureNodeKind,
} from "@jevcode/contracts";

export const ARCH_COLUMN_GAP = 280;
export const ARCH_ROW_GAP = 96;

export interface PositionedArchitectureNode {
  id: string;
  label: string;
  kind: ArchitectureNodeKind;
  path?: string;
  x: number;
  y: number;
}

export function nodeKindClass(kind: ArchitectureNodeKind): string {
  switch (kind) {
    case "module":
      return "jevcode-arch-module";
    case "service":
      return "jevcode-arch-service";
    case "route":
      return "jevcode-arch-route";
    case "middleware":
      return "jevcode-arch-middleware";
    case "config":
      return "jevcode-arch-config";
    case "table":
    case "type":
    case "class":
    case "function":
      return "jevcode-arch-schema-entity";
    case "external":
      return "jevcode-arch-dependency";
  }
}

export function layoutArchitectureNodes(
  nodes: readonly ArchitectureNode[],
  edges: readonly ArchitectureEdge[],
  options: { columnGap?: number; rowGap?: number } = {},
): PositionedArchitectureNode[] {
  const columnGap = options.columnGap ?? ARCH_COLUMN_GAP;
  const rowGap = options.rowGap ?? ARCH_ROW_GAP;

  const byId = new Map<string, ArchitectureNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }

  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    successors.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of edges) {
    if (
      edge.from === edge.to ||
      !byId.has(edge.from) ||
      !byId.has(edge.to)
    ) {
      continue;
    }
    const outgoing = successors.get(edge.from) ?? [];
    if (outgoing.includes(edge.to)) {
      continue;
    }
    outgoing.push(edge.to);
    successors.set(edge.from, outgoing);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const node of nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
    }
  }

  const remaining = new Map(indegree);
  const order: string[] = [];
  const cursor = [...queue];
  let head = 0;
  while (head < cursor.length) {
    const id = cursor[head];
    head += 1;
    if (id === undefined) {
      continue;
    }
    order.push(id);
    for (const next of successors.get(id) ?? []) {
      const nextIndegree = (remaining.get(next) ?? 1) - 1;
      remaining.set(next, nextIndegree);
      if (nextIndegree === 0) {
        cursor.push(next);
      }
    }
  }

  const ordered = new Set(order);
  for (const node of nodes) {
    if (!ordered.has(node.id)) {
      order.push(node.id);
    }
  }

  const predecessors = new Map<string, string[]>();
  for (const [from, targets] of successors) {
    for (const target of targets) {
      const incoming = predecessors.get(target) ?? [];
      incoming.push(from);
      predecessors.set(target, incoming);
    }
  }

  const layer = new Map<string, number>();
  for (const id of order) {
    let depth = 0;
    for (const predecessor of predecessors.get(id) ?? []) {
      const predecessorDepth = layer.get(predecessor);
      if (predecessorDepth !== undefined) {
        depth = Math.max(depth, predecessorDepth + 1);
      }
    }
    layer.set(id, depth);
  }

  const byLayer = new Map<number, string[]>();
  let maxLayer = 0;
  for (const id of order) {
    const depth = layer.get(id) ?? 0;
    maxLayer = Math.max(maxLayer, depth);
    const bucket = byLayer.get(depth) ?? [];
    bucket.push(id);
    byLayer.set(depth, bucket);
  }

  const positioned: PositionedArchitectureNode[] = [];
  for (const [depth, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, index) => {
      const node = byId.get(id);
      if (node === undefined) {
        return;
      }
      positioned.push({
        id: node.id,
        label: node.label,
        kind: node.kind,
        path: node.path,
        x: depth * columnGap,
        y: index * rowGap,
      });
    });
  }
  return positioned;
}
