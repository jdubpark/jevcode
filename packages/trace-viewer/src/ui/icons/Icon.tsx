import type { JSX } from "react";

import type { IconName } from "./icon-names.js";

export interface IconProps { name: IconName; size?: 12 | 14 | 16; title?: string; className?: string }

/** <svg><use href="#tv-i-<name>"/></svg>; aria-hidden unless title is set. */
export function Icon({ name, size = 16, title, className }: IconProps): JSX.Element {
  const a11y = title !== undefined && title.length > 0
    ? { role: "img", "aria-label": title }
    : { "aria-hidden": true };
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" focusable="false" {...a11y}>
      <use href={`#tv-i-${name}`} />
    </svg>
  );
}
