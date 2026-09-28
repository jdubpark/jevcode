import type { JSX } from "react";

import { ICON_NAMES } from "./icon-names.js";
import { ICON_PATHS } from "./paths.js";

export const ICON_ID_PREFIX = "tv-i-";

/** Renders every <symbol id="tv-i-<name>"> once, inside a hidden aria-hidden <svg>; mounted by the Shell. */
export function IconSprite(): JSX.Element {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: "absolute", overflow: "hidden" }}>
      {ICON_NAMES.map((name) => (
        <symbol
          key={name}
          id={`${ICON_ID_PREFIX}${name}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {ICON_PATHS[name].map((d, i) => (
            <path key={i} d={d} />
          ))}
        </symbol>
      ))}
    </svg>
  );
}
