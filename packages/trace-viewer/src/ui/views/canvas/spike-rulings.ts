// M4b spike rulings (docs/spikes/trace-viewer-spike.md, "M4b gate (C3-5)"). Each constant is the
// spec §16 fallback for one risk; the Canvas view reads them at its call sites.

/** Spike risk 3 (text crispness at rest): 64 rounds k to a 1/64 grid at settle; null leaves k alone. */
export const CANVAS_SETTLE_ROUND_K: number | null = 64;

/** Spike risk 7 (edge hairlines, ruler sync): true writes --tv-inv-k every frame instead of at settle. */
export const INV_K_EVERY_FRAME: boolean = false;

/** Spike risk 2 (DOM raster cost at Step level): true culls frames by x0 binary search and caps Step lists. */
export const CULL_FRAMES: boolean = true;
