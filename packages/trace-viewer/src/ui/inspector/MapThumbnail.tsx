import { memo, useMemo } from "react";
import type React from "react";

import { MAP_LANE_PAD, MAP_MARGIN } from "../../layout/map-layout.js";
import type { OverviewModel } from "../../model/index.js";
import { useMapLayouts } from "../views/map/map-layouts.js";
import styles from "./MapThumbnail.module.css";

/**
 * The Map's lanes and cards scaled to the Brief (the approved thumbnail draws no edges); this session's touched components
 * in accent (spec §3.3 item 3). The layout comes from the viewer's layout cache, so it is the Map's own arrangement.
 */
function MapThumbnailView({ overview, touched }: { overview: OverviewModel; touched: readonly string[] }): React.JSX.Element {
  const layouts = useMapLayouts();
  const layout = useMemo(() => layouts.layoutFor(overview), [layouts, overview]);
  const lit = useMemo(() => new Set(touched), [touched]);
  return (
    <div className={styles.frame}>
      <svg
        className={styles.thumb}
        viewBox={`0 0 ${Math.max(1, layout.bounds.w)} ${Math.max(1, layout.bounds.h)}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
        data-map-thumbnail=""
      >
        {layout.bands.map((band) => (
          <rect
            key={band.band}
            x={band.x - MAP_LANE_PAD}
            y={MAP_MARGIN - 4}
            width={band.w + 2 * MAP_LANE_PAD}
            height={layout.bounds.h - 2 * MAP_MARGIN + 10}
            rx={16}
            className={styles.lane}
            data-thumb-lane=""
          />
        ))}
        {layout.cards.map((card) => (
          <rect
            key={card.id}
            x={card.x}
            y={card.y}
            width={card.w}
            height={card.h}
            rx={12}
            className={styles.card}
            data-thumb-card={card.id}
            data-touched={lit.has(card.id) ? "" : undefined}
          />
        ))}
      </svg>
    </div>
  );
}

export const MapThumbnail = memo(MapThumbnailView);
