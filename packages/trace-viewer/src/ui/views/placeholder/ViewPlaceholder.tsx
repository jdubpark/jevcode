import type { JSX } from "react";

import { Icon } from "../../icons/Icon.js";
import type { IconName } from "../../icons/icon-names.js";
import styles from "./ViewPlaceholder.module.css";

function Placeholder({ icon, title, note }: { icon: IconName; title: string; note: string }): JSX.Element {
  return (
    <section className={styles.placeholder} aria-label={title}>
      <Icon name={icon} size={16} className={styles.icon} />
      <p className={styles.title}>{title}</p>
      <p className={styles.note}>{note}</p>
    </section>
  );
}

/** A ViewDefinition Component (it ignores ViewProps); holds key 0 until V-4's ConsoleView replaces it in VIEWS. */
export function ConsolePlaceholder(): JSX.Element {
  return <Placeholder icon="view-console" title="Console" note="The terminal log of this session appears here." />;
}

/** Holds key 3 until lane 06's MapView replaces it in VIEWS. */
export function MapPlaceholder(): JSX.Element {
  return (
    <Placeholder icon="view-map" title="Codebase map" note="A map of this repository appears here once it has been scanned." />
  );
}
