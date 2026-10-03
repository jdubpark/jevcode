import type { MapCard, MapLayout } from "../../../layout/map-layout.js";

export type MapNavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";
const KEYS: ReadonlySet<string> = new Set<MapNavKey>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

export function isMapNavKey(key: string): key is MapNavKey {
  return KEYS.has(key);
}

/** The card a key moves focus to: within a band by row, across bands to the nearest card in height (upper on a tie). */
export function mapNeighbor(layout: MapLayout, fromId: string | null, key: MapNavKey): string | null {
  const cards = layout.cards;
  const first = cards[0];
  if (first === undefined) return null;
  if (key === "Home") return first.id;
  if (key === "End") return cards.at(-1)?.id ?? null;
  const from = fromId === null ? undefined : cards.find((card) => card.id === fromId);
  if (from === undefined) return first.id;
  if (key === "ArrowUp" || key === "ArrowDown") {
    const band = cards.filter((card) => card.band === from.band);
    const at = band.indexOf(from);
    return band[key === "ArrowUp" ? at - 1 : at + 1]?.id ?? null;
  }
  const column = layout.bands.findIndex((band) => band.band === from.band);
  const target = layout.bands[key === "ArrowLeft" ? column - 1 : column + 1];
  if (target === undefined) return null;
  const middle = from.y + from.h / 2;
  let best: MapCard | null = null;
  for (const card of cards) {
    if (card.band !== target.band) continue;
    if (best === null || Math.abs(card.y + card.h / 2 - middle) < Math.abs(best.y + best.h / 2 - middle)) best = card;
  }
  return best?.id ?? null;
}
