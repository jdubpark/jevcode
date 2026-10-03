import { memo } from "react";
import type React from "react";

import type { Component } from "@jevcode/contracts";

import { fileBarPercent, topPackages } from "../../../layout/map-details.js";
import type { MapCard as MapCardBox, MapLevel } from "../../../layout/map-layout.js";
import { displayUntrusted, truncateMiddle } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import { ROLE_ICON, ROLE_LABEL } from "../../icons/kind-icons.js";
import { MARK_WORD, type MapCardState } from "./overlay.js";
import styles from "./MapView.module.css";

export interface MapCardProps {
  box: MapCardBox;
  component: Component;
  level: MapLevel;
  selected: boolean;
  tabStop: boolean;
  /** The file count of the largest component, for the footer bar. */
  maxFiles: number;
  /** Distinct importers when this component is a hub (the glyph shows on the detail level), else null. */
  hubImporters: number | null;
  /** The session marks of this card in drawing order (new or changed, decided, failing); null without an overlay. */
  states: readonly MapCardState[] | null;
  onSelect(id: string): void;
  onHover(id: string | null): void;
}

/**
 * One component (spec §3.4, revised Map mockup). Same box at every level; the content follows it. Chip: name and a footer
 * of role icon and file bar. Card: plus the count. Detail: plus the purpose, the top two packages, "n files" and the hub
 * glyph. A session state mark (lane 07) replaces the count in the footer.
 */
function MapCardView({ box, component, level, selected, tabStop, maxFiles, hubImporters, states, onSelect, onHover }: MapCardProps): React.JSX.Element {
  const name = displayUntrusted(component.name);
  const purpose = component.purpose === null ? null : displayUntrusted(component.purpose);
  const root = displayUntrusted(component.rootPath);
  const count = component.fileCount.toLocaleString("en-US");
  const files = `${count} ${component.fileCount === 1 ? "file" : "files"}`;
  const importers = hubImporters === null ? null : hubImporters.toLocaleString("en-US");
  const packages = level === "detail" ? topPackages(component, 2) : [];
  // The packages row is cut with an ellipsis, so the shown packages' full names go in the accessible name and the tooltip.
  const packageNames = packages.length === 0 ? null : packages.map((ext) => displayUntrusted(ext.name)).join(" · ");
  const label = [
    name,
    ROLE_LABEL[component.role],
    purpose ?? root,
    files,
    packageNames === null ? null : `packages ${packageNames}`,
    importers === null ? null : `imported by ${importers} components`,
    states === null ? null : states.map((state) => MARK_WORD[state]).join(" and "),
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const title = `${name}: ${purpose ?? root}${packageNames === null ? "" : `\nPackages: ${packageNames}`}`;
  return (
    <button
      type="button"
      className={styles.card}
      data-map-card={component.id}
      data-level={level}
      data-selected={selected ? "" : undefined}
      aria-current={selected ? "true" : undefined}
      aria-label={label}
      title={title}
      tabIndex={tabStop ? 0 : -1}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(component.id);
      }}
      onPointerEnter={() => onHover(component.id)}
      onPointerLeave={() => onHover(null)}
    >
      <span className={styles.head}>
        <span className={styles.top}>
          <span className={styles.name}>{name}</span>
          {importers === null || level !== "detail" ? null : (
            <span className={styles.hub} data-map-hub={component.id} title={`Imported by ${importers} components`}>
              <Icon name="fan-in" size={12} />
              <span>{importers}</span>
            </span>
          )}
        </span>
        {level === "detail" ? (
          <>
            {purpose === null ? (
              <span className={styles.purpose} data-map-purpose="" data-fallback="">
                {truncateMiddle(component.rootPath, 40)}
              </span>
            ) : (
              <span className={styles.purpose} data-map-purpose="">
                {purpose}
              </span>
            )}
            {packages.length === 0 ? null : (
              <span className={styles.packages} data-map-packages="">
                <Icon name="pkg" size={12} />
                <span>{packageNames}</span>
              </span>
            )}
          </>
        ) : null}
      </span>
      <span className={styles.foot}>
        <Icon name={ROLE_ICON[component.role]} size={14} />
        <span className={styles.track} aria-hidden="true">
          <i data-map-bar="" style={{ width: `${fileBarPercent(component.fileCount, maxFiles)}%` }} />
        </span>
        {states !== null ? (
          <span className={styles.marks} aria-hidden="true">
            {states.map((state) => (
              <span key={state} className={styles.stateDot} data-state={state} />
            ))}
          </span>
        ) : level === "chip" ? null : (
          <span className={styles.count} data-map-count="">
            {level === "detail" ? files : count}
          </span>
        )}
      </span>
    </button>
  );
}

export const MapCard = memo(MapCardView);
