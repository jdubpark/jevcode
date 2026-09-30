import styles from "../Spine.module.css";

/** Figma-style selection: a 1 px accent outline with four square corner handles, no fill (mockup `.sel`). */
export function SelectionFrame() {
  return (
    <span className={styles.frame} data-selection-frame="" aria-hidden="true">
      <span className={styles.handle} />
      <span className={styles.handle} />
      <span className={styles.handle} />
      <span className={styles.handle} />
    </span>
  );
}
