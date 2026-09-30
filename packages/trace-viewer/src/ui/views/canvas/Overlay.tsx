import { memo, useMemo } from "react";
import type React from "react";

import type { CanvasFrame, CanvasLayout } from "../../../layout/canvas-layout.js";
import type { CanvasEdge } from "../../../layout/canvas-routes.js";
import type { Point } from "../../../layout/viewport.js";
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
import { cullFrames, type CullRange } from "./World.js";
import styles from "./World.module.css";

export interface OverlayProps {
  layout: CanvasLayout;
  ctx: FrameContext;
  level: Level;
  selectedKey: string | null;
  onSelect(frame: CanvasFrame): void;
  /** The World's cull range (CULL_FRAMES); labels outside it are not rendered, the selection's always is. */
  cullRange?: CullRange | null;
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
function labelModels(layout: CanvasLayout, ctx: FrameContext): ReadonlyMap<string, LabelModel> {
  const out = new Map<string, LabelModel>();
  for (const frame of layout.frames) {
    out.set(frame.key, {
      title: frameTitle(frame, ctx),
      fullTitle: frameFullTitle(frame, ctx),
      icon: frameIcon(frame, ctx),
      flag: frameFlag(frame, ctx),
      start: frameStart(frame, ctx),
      approx: frameApprox(frame, ctx),
    });
  }
  return out;
}

/** World px the badge's word takes beside its 24 px mark at k = 1 ("contradicts" at 12 px, the 8 px gap, padding). */
const BADGE_WORD_PX = 88;
const BADGE_MARK_PX = 24;

function overlapsCard(layout: CanvasLayout, x0: number, x1: number, y0: number, y1: number): boolean {
  return layout.frames.some(({ card }) => card.x < x1 && card.x + card.w > x0 && card.y < y1 && card.y + card.h > y0);
}

/** The word goes left of the ≠ mark (mockup) unless a card lies there and the right side is clear. */
export function badgeSide(layout: CanvasLayout, point: Point): "left" | "right" {
  const half = BADGE_MARK_PX / 2;
  const y0 = point.y - half;
  const y1 = point.y + half;
  if (!overlapsCard(layout, point.x - half - BADGE_WORD_PX, point.x - half, y0, y1)) return "left";
  return overlapsCard(layout, point.x + half, point.x + half + BADGE_WORD_PX, y0, y1) ? "left" : "right";
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

function Selection({ frame, ctx }: { frame: CanvasFrame; ctx: FrameContext }): React.JSX.Element {
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
        {timeChip(frameStart(frame, ctx), frameEnd(frame, ctx))}
      </span>
    </>
  );
}

function OverlayView({ layout, ctx, level, selectedKey, onSelect, cullRange = null }: OverlayProps): React.JSX.Element {
  const models = useMemo(() => labelModels(layout, ctx), [layout, ctx]);
  const selected = selectedKey === null ? undefined : layout.frameByKey.get(selectedKey);
  const labelled = level === "session" ? [] : cullFrames(layout.frames, cullRange);
  const labels = selected !== undefined && level !== "session" && !labelled.includes(selected) ? [...labelled, selected] : labelled;
  const badges = useMemo(
    () =>
      layout.edges
        .filter((edge): edge is CanvasEdge & { badge: Point } => edge.kind === "contradicts" && edge.badge !== null)
        .map((edge) => ({ edge, side: badgeSide(layout, edge.badge) })),
    [layout],
  );
  return (
    <div className={styles.overlay} aria-hidden="true">
      {labels.map((frame) => {
        const model = models.get(frame.key);
        return model === undefined ? null : (
          <FrameLabel key={frame.key} frame={frame} model={model} selected={frame.key === selectedKey} onSelect={onSelect} />
        );
      })}
      {layout.separators.map((sep) => (
        <span key={`${sep.kind}:${sep.x}`} className={styles.sepLabel} data-sep-label={sep.kind} style={place({ x: sep.x })}>
          {sep.label}
        </span>
      ))}
      {badges.map(({ edge, side }) => {
        const dim = selectedKey !== null && edge.from !== selectedKey && edge.to !== selectedKey;
        return (
          <span
            key={edge.id}
            className={styles.badge}
            data-badge={edge.id}
            data-dim={dim ? "" : undefined}
            data-side={side}
            style={place({ x: edge.badge.x, y: edge.badge.y })}
          >
            <span className={styles.badgeText}>contradicts</span>
            <span className={styles.badgeMark}>
              <Icon name="neq" size={14} />
            </span>
          </span>
        );
      })}
      {selected === undefined ? null : <Selection frame={selected} ctx={ctx} />}
    </div>
  );
}

/** Screen-space overlay (R17): one DOM layer over the world; every item reads the camera custom properties. */
export const Overlay = memo(OverlayView);
