// Map layout (spec E12, §8.3): pure, React-free and clock-free. Role bands are columns left to right; a band's order
// comes from a barycenter heuristic (4 sweeps, tie-break by name then id) and stays sticky across snapshots of the same
// repo; cards have one fixed size for every zoom level; edges are smooth curves through band gutters and the gap rows
// between cards, so no edge crosses a card other than its endpoints.
import type { Component, ComponentEdge, Role } from "@jevcode/contracts";

import { componentIdForPath, type OverviewModel } from "../model/index.js";

export type MapBand = Role | "side";
export const MAP_BAND_ORDER: readonly MapBand[] = ["ui", "api", "agent", "domain", "storage", "side"];
const SIDE_ROLES: ReadonlySet<Role> = new Set<Role>(["tests", "tooling", "config"]);

export type MapLevel = "chip" | "card" | "detail";

export interface MapLevelSpec {
  w: number;
  h: number;
  /** Space between cards of a column; its center line is the channel long edges run along. */
  rowGap: number;
  /** Width of every gutter between bands, the side band's included. */
  gutter: number;
  /** Width of the side band (tests, tooling, config); it follows the normal gutter. */
  sideW: number;
  /** Package chips beside cards: none at any level (packages show inside detail-level cards). */
  chips: 0;
}

/**
 * World px (approved at gate H2, revised Map mockup). One geometry serves every level, so zooming never moves a card;
 * only the card's content changes with the level.
 */
const GEOMETRY: MapLevelSpec = { w: 140, h: 76, sideW: 104, rowGap: 16, gutter: 22, chips: 0 };
export const MAP_LEVEL_SPECS: { readonly [K in MapLevel]: MapLevelSpec } = { chip: GEOMETRY, card: GEOMETRY, detail: GEOMETRY };
export const MAP_MARGIN = 16;
export const MAP_BAND_LABEL_H = 44;
/** The lane background extends this far beyond a band's cards; used by the view only. */
export const MAP_LANE_PAD = 6;
export const MAP_SWEEPS = 4;

/** Spec §8.3 zoom bands: chip below 0.7, card from 0.7 to below 1.4, detail from 1.4. */
export function mapLevelForZoom(k: number): MapLevel {
  return k < 0.7 ? "chip" : k < 1.4 ? "card" : "detail";
}

/** Spec §3.4: edge width follows the import count in 1 to 3 px buckets. */
export function mapEdgeWidth(count: number): 1 | 2 | 3 {
  return count <= 3 ? 1 : count <= 15 ? 2 : 3;
}

export function bandOf(role: Role): MapBand {
  return SIDE_ROLES.has(role) ? "side" : role;
}

export interface MapCard { id: string; band: MapBand; x: number; y: number; w: number; h: number }
/** `adjacent`: neighboring bands; `long`: two or more bands apart (gap channel); `same`: one band. Additive to interfaces §6.6. */
export type MapEdgeKind = "adjacent" | "long" | "same";
export interface MapEdgePath { from: string; to: string; count: number; width: 1 | 2 | 3; d: string; kind: MapEdgeKind }
/** The interfaces' external type; layoutMap never fills it (spec alignment note 5). */
export interface MapExternalChip { name: string; x: number; y: number; nearComponent: string }
export interface MapBandColumn { band: MapBand; x: number; w: number; count: number }
export interface MapLayoutState { orderByBand: ReadonlyMap<string, readonly string[]>; repoRoot: string }
export interface MapLayout {
  level: MapLevel;
  /** Band order, then row. */
  cards: readonly MapCard[];
  /** Sorted by `from>to`. */
  edges: readonly MapEdgePath[];
  /** Always empty: packages show inside detail-level cards and in the Inspector. */
  externals: readonly MapExternalChip[];
  /** Non-empty bands, left to right. */
  bands: readonly MapBandColumn[];
  bounds: { w: number; h: number };
  state: MapLayoutState;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byNameThenId = (a: Component, b: Component): number => cmp(a.name, b.name) || cmp(a.id, b.id);

interface Neighbor { id: string; w: number }

interface Graph {
  comps: ReadonlyMap<string, Component>;
  band: ReadonlyMap<string, MapBand>;
  /** Cross-band neighbors with count weights, sorted by id (float sums stay deterministic). */
  neighbors: ReadonlyMap<string, readonly Neighbor[]>;
  /** Kept edges, sorted by key. */
  edges: readonly ComponentEdge[];
}

function buildGraph(overview: OverviewModel): Graph {
  const comps = new Map<string, Component>();
  const sorted = [...overview.snapshot.components].sort(
    (a, b) => cmp(a.id, b.id) || byNameThenId(a, b) || cmp(a.contentHash, b.contentHash),
  );
  for (const component of sorted) if (!comps.has(component.id)) comps.set(component.id, component);
  const band = new Map<string, MapBand>();
  for (const component of comps.values()) band.set(component.id, bandOf(component.role));
  const edges: ComponentEdge[] = [];
  const raw = [...overview.snapshot.edges].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || b.count - a.count);
  for (const edge of raw) {
    if (edge.from === edge.to || !comps.has(edge.from) || !comps.has(edge.to)) continue;
    const last = edges.at(-1);
    if (last !== undefined && last.from === edge.from && last.to === edge.to) continue; // a duplicate pair keeps its largest count
    edges.push(edge);
  }
  const neighbors = new Map<string, Neighbor[]>();
  const add = (from: string, to: string, w: number): void => {
    const list = neighbors.get(from);
    if (list === undefined) neighbors.set(from, [{ id: to, w }]);
    else list.push({ id: to, w });
  };
  for (const edge of edges) {
    if (band.get(edge.from) === band.get(edge.to)) continue;
    add(edge.from, edge.to, edge.count);
    add(edge.to, edge.from, edge.count);
  }
  for (const list of neighbors.values()) list.sort((a, b) => cmp(a.id, b.id) || a.w - b.w);
  return { comps, band, neighbors, edges };
}

type Order = Map<MapBand, string[]>;

function emptyOrder(): Order {
  return new Map(MAP_BAND_ORDER.map((band) => [band, [] as string[]]));
}

function listOf(order: Order, band: MapBand): string[] {
  let list = order.get(band);
  if (list === undefined) {
    list = [];
    order.set(band, list);
  }
  return list;
}

function bandOfId(graph: Graph, id: string): MapBand {
  return graph.band.get(id) ?? "domain";
}

/** Normalized positions: index ÷ (size − 1), so bands of different sizes compare. */
function setPositions(list: readonly string[], pos: Map<string, number>): void {
  const span = Math.max(1, list.length - 1);
  list.forEach((id, index) => pos.set(id, index / span));
}

function barycenter(id: string, graph: Graph, pos: ReadonlyMap<string, number>): number | null {
  let sum = 0;
  let weight = 0;
  for (const neighbor of graph.neighbors.get(id) ?? []) {
    const p = pos.get(neighbor.id);
    if (p === undefined) continue;
    sum += p * neighbor.w;
    weight += neighbor.w;
  }
  return weight > 0 ? sum / weight : null;
}

function freshOrder(graph: Graph): Order {
  const order = emptyOrder();
  for (const component of [...graph.comps.values()].sort(byNameThenId)) listOf(order, bandOfId(graph, component.id)).push(component.id);
  const pos = new Map<string, number>();
  for (const list of order.values()) setPositions(list, pos);
  const bands = MAP_BAND_ORDER.filter((band) => listOf(order, band).length > 1);
  for (let sweep = 0; sweep < MAP_SWEEPS; sweep += 1) {
    const pass = sweep % 2 === 0 ? bands : [...bands].reverse();
    for (const band of pass) {
      const keyed = listOf(order, band).map((id) => ({ id, bc: barycenter(id, graph, pos) ?? pos.get(id) ?? 0, comp: graph.comps.get(id) }));
      keyed.sort((a, b) => a.bc - b.bc || (a.comp !== undefined && b.comp !== undefined ? byNameThenId(a.comp, b.comp) : cmp(a.id, b.id)));
      const next = keyed.map((item) => item.id);
      order.set(band, next);
      setPositions(next, pos);
    }
  }
  return order;
}

function stickyOrder(graph: Graph, prev: MapLayoutState): Order {
  const order = emptyOrder();
  const placed = new Set<string>();
  for (const band of MAP_BAND_ORDER) {
    const kept: string[] = [];
    for (const id of prev.orderByBand.get(band) ?? []) {
      if (graph.band.get(id) !== band || placed.has(id)) continue;
      kept.push(id);
      placed.add(id);
    }
    order.set(band, kept);
  }
  const pending = [...graph.comps.values()].filter((component) => !placed.has(component.id)).sort(byNameThenId);
  if (pending.length === 0) return order;
  const pos = new Map<string, number>();
  for (const list of order.values()) setPositions(list, pos);
  for (const component of pending) {
    const list = listOf(order, bandOfId(graph, component.id));
    const bc = barycenter(component.id, graph, pos);
    const at = bc === null ? list.length : Math.min(list.length, Math.max(0, Math.round(bc * list.length)));
    list.splice(at, 0, component.id);
    setPositions(list, pos);
  }
  return order;
}

interface Placed { card: MapCard; col: number; row: number }

/**
 * Smooth routes (revised Map mockup; spec §8.3). One port per card side, at its vertical center. Adjacent bands: one
 * S-curve in the gutter. Bands two or more apart: leave into the gutter, run along the gap row between cards (all bands
 * share one row pitch, so it is free in every column), come back through the gutter before the target. Same band: a
 * shallow bulge on the less loaded side. Edges leaving one card toward one side at one channel share it exactly.
 * No lane assignment, spreading or per-edge string keys: each edge is O(1) after one pass over the edges for loads.
 */
function routeEdges(graph: Graph, placed: ReadonlyMap<string, Placed>, bands: readonly MapBandColumn[], spec: MapLevelSpec, top: number, rows: number): MapEdgePath[] {
  // graph.edges is sorted by (from, to); component ids have one fixed length, so this is also edge-key order.
  interface Normalized { edge: ComponentEdge; l: Placed; r: Placed }
  const load = bands.map(() => ({ left: 0, right: 0 }));
  const normalized: Normalized[] = [];
  for (const edge of graph.edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (a === undefined || b === undefined) continue;
    const swap = b.col < a.col || (b.col === a.col && b.row < a.row);
    const l = swap ? b : a;
    const r = swap ? a : b;
    normalized.push({ edge, l, r });
    if (l.col === r.col) continue;
    const right = load[l.col];
    const left = load[r.col];
    if (right !== undefined) right.right += 1;
    if (left !== undefined) left.left += 1;
  }
  const pitch = spec.h + spec.rowGap;
  const hh = spec.gutter / 2;
  return normalized.map(({ edge, l, r }) => {
    const y1 = l.card.y + l.card.h / 2;
    const y2 = r.card.y + r.card.h / 2;
    const kind: MapEdgeKind = l.col === r.col ? "same" : r.col - l.col === 1 ? "adjacent" : "long";
    let d: string;
    if (kind === "same") {
      const use = load[l.col];
      const right = use === undefined || use.right <= use.left;
      const x0 = right ? l.card.x + l.card.w : l.card.x;
      const bulge = Math.min(hh - 2, 4 + 3 * (r.row - l.row));
      const bx = right ? x0 + bulge : x0 - bulge;
      d = `M${x0} ${y1}C${bx} ${y1} ${bx} ${y2} ${x0} ${y2}`;
    } else {
      const x1 = l.card.x + l.card.w;
      const x2 = r.card.x;
      if (kind === "adjacent") {
        const mx = (x1 + x2) / 2;
        d = `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
      } else {
        const b = Math.max(1, Math.min(rows, y2 >= y1 ? l.row + 1 : l.row));
        const yc = top + b * pitch - spec.rowGap / 2;
        const gx1 = x1 + spec.gutter;
        const gx2 = x2 - spec.gutter;
        d = `M${x1} ${y1}C${x1 + hh} ${y1} ${x1 + hh} ${yc} ${gx1} ${yc}H${gx2}C${gx2 + hh} ${yc} ${gx2 + hh} ${y2} ${x2} ${y2}`;
      }
    }
    return { from: edge.from, to: edge.to, count: edge.count, width: mapEdgeWidth(edge.count), d, kind };
  });
}

/** Distinct importers per component: `edge.from` imports `edge.to`. Layout edges are already de-duplicated, but a set keeps this safe for any list. */
export function mapImporterCounts(layoutEdges: readonly MapEdgePath[]): ReadonlyMap<string, number> {
  const importers = new Map<string, Set<string>>();
  for (const edge of layoutEdges) {
    const set = importers.get(edge.to);
    if (set === undefined) importers.set(edge.to, new Set([edge.from]));
    else set.add(edge.from);
  }
  return new Map([...importers].map(([id, set]) => [id, set.size] as const));
}

/** A hub (revised Map mockup) is imported by at least max(6, ceil(n / 4)) distinct components; the view hides edges into it at rest. */
export function mapHubIds(layoutEdges: readonly MapEdgePath[], componentCount: number): ReadonlySet<string> {
  const threshold = Math.max(6, Math.ceil(componentCount / 4));
  const hubs = new Set<string>();
  for (const [id, count] of mapImporterCounts(layoutEdges)) if (count >= threshold) hubs.add(id);
  return hubs;
}

export function layoutMap(overview: OverviewModel, opts: { level: MapLevel }, prev?: MapLayoutState): MapLayout {
  const spec = MAP_LEVEL_SPECS[opts.level];
  const graph = buildGraph(overview);
  const repoRoot = overview.snapshot.repoRoot;
  const order = prev !== undefined && prev.repoRoot === repoRoot ? stickyOrder(graph, prev) : freshOrder(graph);
  const top = MAP_MARGIN + MAP_BAND_LABEL_H;
  const pitch = spec.h + spec.rowGap;
  const bands: MapBandColumn[] = [];
  const cards: MapCard[] = [];
  const placed = new Map<string, Placed>();
  let x = MAP_MARGIN;
  let rows = 0;
  for (const band of MAP_BAND_ORDER) {
    const ids = listOf(order, band);
    if (ids.length === 0) continue;
    if (bands.length > 0) x += spec.gutter;
    const col = bands.length;
    const w = band === "side" ? spec.sideW : spec.w;
    bands.push({ band, x, w, count: ids.length });
    ids.forEach((id, row) => {
      const card: MapCard = { id, band, x, y: top + row * pitch, w, h: spec.h };
      cards.push(card);
      placed.set(id, { card, col, row });
    });
    rows = Math.max(rows, ids.length);
    x += w;
  }
  const last = bands.at(-1);
  return {
    level: opts.level,
    cards,
    edges: routeEdges(graph, placed, bands, spec, top, rows),
    externals: [],
    bands,
    bounds: { w: last === undefined ? 2 * MAP_MARGIN : last.x + last.w + MAP_MARGIN, h: top + Math.max(0, rows * pitch - spec.rowGap) + MAP_MARGIN },
    state: { orderByBand: new Map(MAP_BAND_ORDER.map((band) => [band, [...listOf(order, band)]] as const)), repoRoot },
  };
}

/**
 * The component a repo path belongs to: strips the repo root and "./", then applies the model's one path rule
 * (componentIdForPath, ruling R6: listed file, then longest root, then "."). Entity paths may be absolute.
 */
export function componentForPath(overview: OverviewModel, path: string): string | undefined {
  const repoPrefix = `${overview.snapshot.repoRoot.replace(/\/+$/, "")}/`;
  let relative = path.startsWith(repoPrefix) ? path.slice(repoPrefix.length) : path;
  while (relative.startsWith("./")) relative = relative.slice(2);
  return componentIdForPath(overview.snapshot.components, relative) ?? undefined;
}
