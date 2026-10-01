import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import type { TraceSession } from "../../model/index.js";

export const REGIONS = ["outline", "main", "inspector"] as const;
export type Region = (typeof REGIONS)[number];

export function regionOf(element: Element | null): Region | null {
  const value = element?.closest("[data-region]")?.getAttribute("data-region") ?? null;
  return value === "outline" || value === "main" || value === "inspector" ? value : null;
}

export function nextRegion(current: Region | null, dir: 1 | -1): Region {
  if (current === null) return dir === 1 ? "outline" : "inspector";
  const position = REGIONS.indexOf(current);
  return REGIONS[(position + dir + REGIONS.length) % REGIONS.length] ?? "outline";
}

/**
 * Whether an element can take focus for now. jsdom has no layout (getClientRects is always empty), so this walks the
 * ancestors and rejects `hidden`, `inert` and computed `display: none` (what a hidden Activity subtree applies).
 */
export function isFocusable(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.hidden || node.hasAttribute("inert")) return false;
    const view = node.ownerDocument.defaultView;
    if (view !== null && view.getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/** Focuses the region's first visible roving tab stop, else the region element; false when the region is absent. */
export function focusRegion(root: ParentNode, region: Region): boolean {
  const container = root.querySelector<HTMLElement>(`[data-region="${region}"]`);
  if (container === null || !isFocusable(container)) return false;
  const stops = container.querySelectorAll<HTMLElement>('[tabindex="0"]');
  const target = Array.from(stops).find(isFocusable) ?? container;
  target.focus({ preventScroll: true });
  return true;
}
export function isEditableTarget(target: Element | null): boolean {
  if (target === null) return false;
  if (target.closest("input, textarea, select") !== null) return true;
  const editable = target.closest("[contenteditable]");
  return editable !== null && editable.getAttribute("contenteditable") !== "false";
}

/** Whether `view` (the root's own window, so a popout window reads its own selection) has a non-empty selection. */
export function hasTextSelection(view: Window | null): boolean {
  const selection = view?.getSelection() ?? null;
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
}

/** j/k over a view's reading order; an unknown id falls back to its parent (step → unit); nothing selected starts at an end; null at an end. */
export function nextInOrder(
  order: readonly SelectionId[],
  current: SelectionId | null,
  dir: 1 | -1,
  index: TraceIndex,
): SelectionId | null {
  if (order.length === 0) return null;
  let position = current === null ? -1 : order.indexOf(current);
  if (position < 0 && current !== null) {
    const parent = index.entry(current)?.parent ?? null;
    if (parent !== null) position = order.indexOf(parent);
  }
  if (position < 0) return dir === 1 ? (order[0] ?? null) : (order[order.length - 1] ?? null);
  return order[position + dir] ?? null;
}

/** The adjacent session step beyond a view's reading order (Hybrid j past the brush edge slides the brush). */
export function adjacentStep(
  session: TraceSession,
  index: TraceIndex,
  current: SelectionId | null,
  dir: 1 | -1,
): SelectionId | null {
  if (current === null) return null;
  const entry = index.entry(current);
  if (entry === undefined || entry.kind !== "step") return null;
  return session.steps[entry.position + dir]?.id ?? null;
}
