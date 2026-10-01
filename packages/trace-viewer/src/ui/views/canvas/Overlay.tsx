import { memo, useMemo } from "react";
import type React from "react";

import type { CanvasFrame, CanvasLayout } from "../../../layout/canvas-layout.js";
import type { CanvasEdge } from "../../../layout/canvas-routes.js";
import type { Point, Rect } from "../../../layout/viewport.js";
import { formatOffset, type Level } from "../../../model/index.js";
import type { IconName } from "../../icons/icon-names.js";
import { Icon } from "../../icons/Icon.js";
import {
  frameApprox,
  frameEnd,
  frameFlag,
  frameFullTitle,
  frameIcon,
  frameStart,
  frameTitle,
  timeChip,
  type FrameContext,
  type FrameFlag,
} from "./frame-label.js";
import { cullFrames, cullSeparators, type CullRange } from "./World.js";
import styles from "./World.module.css";

export interface OverlayProps {
  layout: CanvasLayout;
  ctx: FrameContext;
  /** Each frame's flag (FrameMarks.flags); derived per frame when omitted. */
  flags?: ReadonlyMap<string, FrameFlag> | undefined;
  level: Level;
  selectedKey: string | null;
  onSelect(frame: CanvasFrame): void;
  /**
   * The World's cull range (CULL_FRAMES); labels, separator labels and badges outside it are not rendered, the
   * selection's label always is.
   */
  cullRange?: CullRange | null;
  /**
   * The overlay root. The camera writes --tv-tx, --tv-ty and --tv-k here and nowhere above it, so a camera frame
   * restyles only this subtree (C3-10 review I-1).
   */
  rootRef?: React.Ref<HTMLDivElement>;
  /**
   * The camera zoom the badge words are placed for (the mounted camera's k: it changes at settle and during a long
   * zoom, never per frame). Overlay items keep their screen size, so their world extent is px / k. Default 1.
   */
  k?: number;
}

/** World coordinates as unitless custom properties; the CSS maps them through --tv-tx/--tv-ty/--tv-k. */
function place(values: Record<string, number>): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) style[`--${name}`] = String(value);
  return style as React.CSSProperties;
}

interface LabelModel {
  title: string;
  fullTitle: string;
  icon: IconName;
  flag: FrameFlag;
  start: number;
  approx: boolean;
}

/** Label text per frame, derived once per (layout, ctx): selection changes and camera ticks reuse it. */
function labelModels(
  layout: CanvasLayout,
  ctx: FrameContext,
  flags: ReadonlyMap<string, FrameFlag> | undefined,
): ReadonlyMap<string, LabelModel> {
  const out = new Map<string, LabelModel>();
  for (const frame of layout.frames) {
    out.set(frame.key, {
      title: frameTitle(frame, ctx),
      fullTitle: frameFullTitle(frame, ctx),
      icon: frameIcon(frame, ctx),
      flag: flags?.has(frame.key) === true ? (flags.get(frame.key) ?? null) : frameFlag(frame, ctx),
      start: frameStart(frame, ctx),
      approx: frameApprox(frame, ctx),
    });
  }
  return out;
}

/** Screen px the badge's word takes beside its 24 px mark ("contradicts" at 12 px, the 8 px gap, padding). */
const BADGE_WORD_PX = 88;
const BADGE_MARK_PX = 24;
/** World.module.css .timeChip: 18 px high, 8 px under the card, 6 px padding; 12 px tabular digits ≈ 7 px each. */
const CHIP_GAP_PX = 8;
const CHIP_H_PX = 18;
const CHIP_PAD_PX = 6;
const CHIP_CHAR_PX = 7;

/** The selection's time chip in world px at zoom k: centered under the card, screen-sized. */
export function timeChipRect(frame: CanvasFrame, text: string, k = 1): Rect {
  const w = (text.length * CHIP_CHAR_PX + 2 * CHIP_PAD_PX) / k;
  return { x: frame.card.x + frame.card.w / 2 - w / 2, y: frame.card.y + frame.card.h + CHIP_GAP_PX / k, w, h: CHIP_H_PX / k };
}

function hits(rect: Rect | null, x0: number, x1: number, y0: number, y1: number): boolean {
  return rect !== null && rect.x < x1 && rect.x + rect.w > x0 && rect.y < y1 && rect.y + rect.h > y0;
}

/** Cards, their label rows and the selection's chip: anything the word may not cover. */
function blocked(frames: readonly CanvasFrame[], chip: Rect | null, x0: number, x1: number, y0: number, y1: number): boolean {
  return hits(chip, x0, x1, y0, y1) || frames.some(({ card, label }) => hits(card, x0, x1, y0, y1) || hits(label, x0, x1, y0, y1));
}

export type BadgeSide = "left" | "right" | "mark";

export interface BadgeSideOptions {
  /** Camera zoom (default 1): the word and the mark keep their screen size. */
  k?: number;
  /** The selection's time chip (timeChipRect), when a frame is selected. */
  chip?: Rect | null;
  /** Frames to test; the layout's frames by default (the Overlay passes the culled ones). */
  frames?: readonly CanvasFrame[];
}

/**
 * The word goes left of the ≠ mark (mockup) unless a card, a frame label or the selection's chip lies there, then
 * right; when both sides are blocked only the mark shows and the word moves to its tooltip (lane review I-4).
 */
export function badgeSide(layout: Pick<CanvasLayout, "frames">, point: Point, options: BadgeSideOptions = {}): BadgeSide {
  const k = options.k ?? 1;
  const frames = options.frames ?? layout.frames;
  const chip = options.chip ?? null;
  const half = BADGE_MARK_PX / 2 / k;
  const word = BADGE_WORD_PX / k;
  const y0 = point.y - half;
  const y1 = point.y + half;
  if (!blocked(frames, chip, point.x - half - word, point.x - half, y0, y1)) return "left";
  if (!blocked(frames, chip, point.x + half, point.x + half + word, y0, y1)) return "right";
  return "mark";
}

interface FrameLabelProps {
  frame: CanvasFrame;
  model: LabelModel;
  selected: boolean;
  onSelect(frame: CanvasFrame): void;
}

const FrameLabel = memo(function FrameLabel({ frame, model, selected, onSelect }: FrameLabelProps): React.JSX.Element | null {
  if (frame.label === null) return null;
  return (
    <div
      className={styles.label}
      data-label-for={frame.key}
      data-selected={selected ? "" : undefined}
      title={model.fullTitle}
      style={place({ x: frame.label.x, cy: frame.card.y, w: frame.label.w })}
      onClick={() => onSelect(frame)}
    >
      <Icon name={model.icon} size={14} className={styles.labelIcon} />
      <span className={styles.labelText}>{model.title}</span>
      {model.approx ? <span className={styles.labelTime}>≈</span> : null}
      {model.flag === "neq" ? <Icon name="neq" size={12} className={styles.flagBad} /> : null}
      {model.flag === "shield" ? <Icon name="shield" size={12} className={styles.flagIcon} /> : null}
      {model.flag === "failed" ? <span className={styles.flagBad}>✕</span> : null}
      <span className={styles.labelTime}>{formatOffset(model.start)}</span>
    </div>
  );
});

function Selection({ frame, chip }: { frame: CanvasFrame; chip: string }): React.JSX.Element {
  const { card } = frame;
  const corners: Array<[string, number, number]> = [
    ["nw", card.x, card.y],
    ["ne", card.x + card.w, card.y],
    ["sw", card.x, card.y + card.h],
    ["se", card.x + card.w, card.y + card.h],
  ];
  return (
    <>
      {corners.map(([name, x, y]) => (
        <span key={name} className={styles.handle} data-handle={name} style={place({ x, y })} />
      ))}
      <span className={styles.timeChip} data-time-chip="" style={place({ x: card.x + card.w / 2, y: card.y + card.h })}>
        {chip}
      </span>
    </>
  );
}

function OverlayView({ layout, ctx, flags, level, selectedKey, onSelect, cullRange = null, rootRef, k = 1 }: OverlayProps): React.JSX.Element {
  const models = useMemo(() => labelModels(layout, ctx, flags), [layout, ctx, flags]);
  const selected = selectedKey === null ? undefined : layout.frameByKey.get(selectedKey);
  const culled = useMemo(() => cullFrames(layout.frames, cullRange), [layout, cullRange]);
  const labelled = level === "session" ? [] : culled;
  const labels = selected !== undefined && level !== "session" && !labelled.includes(selected) ? [...labelled, selected] : labelled;
  const chipText = useMemo(
    () => (selected === undefined ? null : timeChip(frameStart(selected, ctx), frameEnd(selected, ctx))),
    [selected, ctx],
  );
  // Per (layout, cull range, zoom, selection): the mounted camera changes at settle, never per camera frame.
  const shownBadges = useMemo(() => {
    const chip = selected === undefined || chipText === null ? null : timeChipRect(selected, chipText, k);
    return layout.edges
      .filter((edge): edge is CanvasEdge & { badge: Point } => edge.kind === "contradicts" && edge.badge !== null)
      .filter(
        (edge) =>
          cullRange === null ||
          edge.from === selectedKey ||
          edge.to === selectedKey ||
          (edge.badge.x >= cullRange.x0 && edge.badge.x <= cullRange.x1),
      )
      .map((edge) => ({ edge, side: badgeSide(layout, edge.badge, { k, chip, frames: culled }) }));
  }, [layout, culled, cullRange, k, selected, selectedKey, chipText]);
  return (
    <div ref={rootRef} className={styles.overlay} data-tv-overlay="" aria-hidden="true">
      {labels.map((frame) => {
        const model = models.get(frame.key);
        return model === undefined ? null : (
          <FrameLabel key={frame.key} frame={frame} model={model} selected={frame.key === selectedKey} onSelect={onSelect} />
        );
      })}
      {cullSeparators(layout.separators, cullRange).map((sep) => (
        <span key={`${sep.kind}:${sep.x}`} className={styles.sepLabel} data-sep-label={sep.kind} style={place({ x: sep.x })}>
          {sep.label}
        </span>
      ))}
      {shownBadges.map(({ edge, side }) => {
        const dim = selectedKey !== null && edge.from !== selectedKey && edge.to !== selectedKey;
        return (
          <span
            key={edge.id}
            className={styles.badge}
            data-badge={edge.id}
            data-dim={dim ? "" : undefined}
            data-side={side}
            title={side === "mark" ? "contradicts" : undefined}
            style={place({ x: edge.badge.x, y: edge.badge.y })}
          >
            {side === "mark" ? null : <span className={styles.badgeText}>contradicts</span>}
            <span className={styles.badgeMark}>
              <Icon name="neq" size={14} />
            </span>
          </span>
        );
      })}
      {selected === undefined || chipText === null ? null : <Selection frame={selected} chip={chipText} />}
    </div>
  );
}

/** Screen-space overlay (R17): one DOM layer over the world; every item reads the camera custom properties on its root. */
export const Overlay = memo(OverlayView);
