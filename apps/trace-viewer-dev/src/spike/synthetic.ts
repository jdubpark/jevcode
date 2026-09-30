export interface BenchSize { chapters: number; edges: number }
export interface SpikeFrame {
  key: string; index: number; col: number;
  x: number; y: number; w: number; h: number;
  title: string; label: string; rows: readonly string[];
  critical: boolean; story: boolean;
}
export interface SpikeEdge { id: string; d: string; bad: boolean }
export interface SpikeMark { lane: number; u0: number; u1: number; bad: boolean }
export interface SpikePin { key: string; lane: number; u: number; label: string; bad: boolean }
export interface SpikeScene {
  frames: SpikeFrame[]; edges: SpikeEdge[]; marks: SpikeMark[]; pins: SpikePin[];
  bounds: { x: number; y: number; w: number; h: number };
  endU: number; columns: number;
}

export const PITCH = 264;
export const FRAME_W = 240;
export const STORY_H = 44;
export const STEP_H = 292;
export const WORK_TOP = 128;
export const COLUMN_MS = 20_000;
export const STORY_FRAMES = 40;
export const LANE_COUNT = 6;
export const MARK_COUNT = 5_000;

/** "?bench=60x300" → 60 chapters and 300 edges (the spec §16 scene). */
export function parseBench(value: string | null): BenchSize {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (match === null) return { chapters: 60, edges: 300 };
  return { chapters: Math.max(1, Number(match[1])), edges: Math.max(0, Number(match[2])) };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function offsetLabel(ms: number): string {
  const s = Math.floor(ms / 1_000);
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 60 chapters (Step level, nine-row lists) + 40 story frames ≈ 4k DOM nodes, 300 edges, 5k lane marks. */
export function buildScene(size: BenchSize, seed = 7): SpikeScene {
  const rand = mulberry32(seed);
  const columns = Math.max(1, Math.ceil(size.chapters / 3), Math.ceil(STORY_FRAMES / 2));
  const frames: SpikeFrame[] = [];
  for (let i = 0; i < STORY_FRAMES; i += 1) {
    const col = Math.floor(i / 2) % columns;
    frames.push({
      key: `story:${i}`, index: 0, col, x: col * PITCH, y: (i % 2) * (STORY_H + 8), w: FRAME_W, h: STORY_H,
      title: `Intent ${i + 1}`, label: `Intent ${i + 1}, ${offsetLabel(col * COLUMN_MS)}`, rows: [], critical: false, story: true,
    });
  }
  for (let i = 0; i < size.chapters; i += 1) {
    const col = Math.floor(i / 3);
    const row = i % 3;
    const failed = rand() < 0.1 ? 1 + Math.floor(rand() * 3) : 0;
    const passed = 5 + Math.floor(rand() * 20);
    const title = `Chapter ${i + 1}`;
    frames.push({
      key: `ch:${i}`, index: 0, col, x: col * PITCH, y: WORK_TOP + row * (STEP_H + 24), w: FRAME_W, h: STEP_H,
      title, label: `${title}, ${failed} failed, ${passed} passed, ${offsetLabel(col * COLUMN_MS + row * 1_000)}`,
      rows: Array.from({ length: 9 }, (_, r) => `pnpm test --filter pkg-${i}-${r}`), critical: failed > 0, story: false,
    });
  }
  frames.sort((a, b) => a.col - b.col || a.y - b.y);
  frames.forEach((frame, index) => { frame.index = index; });
  const work = frames.filter((frame) => !frame.story);
  const edges: SpikeEdge[] = [];
  for (let i = 0; i < size.edges && work.length > 1; i += 1) {
    const a = work[Math.floor(rand() * (work.length - 1))];
    if (a === undefined) break;
    const later = work.filter((frame) => frame.col > a.col);
    const b = later[Math.floor(rand() * later.length)] ?? work[work.length - 1];
    if (b === undefined) break;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    edges.push({ id: `e${i}`, d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, bad: rand() < 0.02 });
  }
  const endU = columns * COLUMN_MS;
  const marks: SpikeMark[] = [];
  for (let i = 0; i < MARK_COUNT; i += 1) {
    const u0 = rand() * endU;
    marks.push({ lane: i % LANE_COUNT, u0, u1: u0 + (rand() < 0.3 ? rand() * 3_000 : 0), bad: rand() < 0.02 });
  }
  marks.sort((a, b) => a.u0 - b.u0);
  const pins: SpikePin[] = Array.from({ length: 60 }, (_, i) => ({
    key: `pin:${i}`, lane: i % LANE_COUNT, u: ((i + 0.5) / 60) * endU, label: `Pin ${i + 1}`, bad: i % 10 === 0,
  }));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.h));
  return { frames, edges, marks, pins, bounds: { x: 0, y: 0, w: columns * PITCH - (PITCH - FRAME_W), h: bottom }, endU, columns };
}
