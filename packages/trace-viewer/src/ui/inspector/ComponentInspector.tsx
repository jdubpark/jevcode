import { useMemo } from "react";
import type React from "react";

import { componentDetails, DETAIL_LINKS_SHOWN, listBarPx, type MapLink } from "../../layout/map-details.js";
import { displayUntrusted, truncateMiddle } from "../../model/index.js";
import { DiffBar } from "../graphics/DiffBar.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { ROLE_ICON, ROLE_LABEL } from "../icons/kind-icons.js";
import { useSessionView } from "../shell/session-context.js";
import { useViewStore } from "../state/store.js";
import styles from "./ComponentInspector.module.css";
import base from "./Inspector.module.css";

/** The Inspector for a Map component (spec §3.4): purpose with provenance, files, imports both ways, packages, this
 *  session's changes and the overview sentences that cite it. Every repo and narrator string goes through displayUntrusted. */
export function ComponentInspector({ componentId }: { componentId: string }): React.JSX.Element {
  const view = useSessionView();
  const store = useViewStore();
  const session = view.session;
  const overview = session?.overview ?? null;
  const component = overview?.componentById.get(componentId);
  const details = useMemo(
    () => (session === null || overview === null ? null : componentDetails(overview, componentId, session)),
    [session, overview, componentId],
  );
  if (overview === null || component === undefined || details === null) {
    return (
      <div className={base.inspector} data-component-inspector="">
        <p className={`${styles.quiet} ${styles.missing}`}>This component is no longer in the map.</p>
      </div>
    );
  }
  const name = displayUntrusted(component.name);
  const purpose = component.purpose === null ? null : displayUntrusted(component.purpose);
  const provenance = component.provenance === "model" ? "described by model" : "rule-based";
  const iconOf = (id: string): IconName => {
    const other = overview.componentById.get(id);
    return other === undefined ? "role-domain" : ROLE_ICON[other.role];
  };
  const largest = (counts: readonly number[]): number => counts.reduce((most, count) => Math.max(most, count), 0);
  const links = (kind: "in" | "out", list: readonly MapLink[]): React.JSX.Element => (
    <div data-imports={kind}>
      <h3 className={styles.heading}>{`${kind === "out" ? "Imports out" : "Imports in"} · ${list.length.toLocaleString("en-US")}`}</h3>
      {list.length === 0 ? (
        <p className={styles.quiet}>{component.importsAnalyzed ? "None" : "Not analyzed for this language"}</p>
      ) : (
        <ul className={styles.list}>
          {list.slice(0, DETAIL_LINKS_SHOWN).map((link) => (
            <li key={link.id}>
              <span className={styles.row}>
                <Icon name={iconOf(link.id)} size={12} />
                <span className={styles.rowName} title={displayUntrusted(link.name)}>
                  {displayUntrusted(link.name)}
                </span>
                <span className={styles.bar} data-list-bar="" aria-hidden="true" style={{ width: listBarPx(link.count, largest(list.map((item) => item.count))) }} />
                <span className={styles.count}>{link.count.toLocaleString("en-US")}</span>
              </span>
              {link.example === null ? null : (
                <p className={`${styles.mono} ${styles.example}`} title={displayUntrusted(link.example)}>
                  {displayUntrusted(link.example)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.length > DETAIL_LINKS_SHOWN ? <p className={styles.quiet}>{`${(list.length - DETAIL_LINKS_SHOWN).toLocaleString("en-US")} more`}</p> : null}
    </div>
  );
  return (
    <div className={base.inspector} data-component-inspector={component.id}>
      <div className={base.header}>
        <div className={base.tile}>
          <Icon name={ROLE_ICON[component.role]} size={16} />
        </div>
        <div className={base.headText}>
          <h2 className={base.title} data-slot="title" title={name}>
            {name}
          </h2>
          <p className={base.metaLine}>
            <span>{`${ROLE_LABEL[component.role]} · ${provenance}`}</span>
            {component.roleGuess === component.role ? null : <span>{`· guessed ${ROLE_LABEL[component.roleGuess]}`}</span>}
          </p>
        </div>
      </div>
      <div className={base.body}>
        <section className={styles.section} aria-label="Purpose">
          {purpose === null ? <p className={styles.quiet}>No description yet</p> : <p className={styles.purpose}>{purpose}</p>}
          <p className={styles.mono} title={displayUntrusted(component.rootPath)}>
            {truncateMiddle(component.rootPath, 48)}
          </p>
        </section>
        <section className={styles.section} aria-label="Files">
          <h3 className={styles.heading}>
            <Icon name="file" size={12} />
            <span>{`Files · ${component.fileCount.toLocaleString("en-US")}`}</span>
            {component.language === null ? null : <span className={styles.dim}>{displayUntrusted(component.language)}</span>}
          </h3>
          <ul className={styles.list}>
            {details.files.shown.map((file) => (
              <li key={file} className={styles.mono} data-component-file="" title={displayUntrusted(file)} aria-label={displayUntrusted(file)}>
                {truncateMiddle(file, 48)}
              </li>
            ))}
          </ul>
          {details.files.more > 0 ? <p className={styles.quiet}>{`${details.files.more.toLocaleString("en-US")} more`}</p> : null}
        </section>
        <section className={styles.section} aria-label="Imports">
          {links("out", details.importsOut)}
          {links("in", details.importsIn)}
        </section>
        {details.externals.length === 0 ? null : (
          <section className={styles.section} aria-label="External packages">
            <h3 className={styles.heading}>
              <Icon name="pkg" size={12} />
              <span>External packages</span>
            </h3>
            <ul className={styles.list}>
              {details.externals.map((ext) => (
                <li key={ext.name} className={styles.row} data-component-package="">
                  <span className={styles.rowName} title={displayUntrusted(ext.name)}>
                    {displayUntrusted(ext.name)}
                  </span>
                  <span className={styles.bar} data-list-bar="" aria-hidden="true" style={{ width: listBarPx(ext.count, largest(details.externals.map((item) => item.count))) }} />
                  <span className={styles.count}>{ext.count.toLocaleString("en-US")}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className={styles.section} aria-label="This session">
          <h3 className={styles.heading}>
            <Icon name="edit" size={12} />
            <span>This session</span>
          </h3>
          {details.changes.length === 0 ? (
            <p className={styles.quiet}>No changes in this session</p>
          ) : (
            details.changes.map((change) => (
              <button
                key={change.path}
                type="button"
                className={styles.change}
                data-component-change=""
                title={displayUntrusted(change.path)}
                aria-label={`${displayUntrusted(change.path)}, ${change.added.toLocaleString("en-US")} lines added, ${change.removed.toLocaleString("en-US")} removed`}
                // Selecting the step also drops the component selection (the reducer's selectId), so its Inspector shows.
                onClick={() => store.dispatch({ type: "select", id: change.stepId, by: "shell" })}
              >
                <span className={styles.rowName}>{truncateMiddle(change.path, 36)}</span>
                <DiffBar size="xs" added={change.added} removed={change.removed} />
              </button>
            ))
          )}
        </section>
        {details.citations.length === 0 ? null : (
          <section className={styles.section} aria-label="Cited in the overview">
            <h3 className={styles.heading}>
              <Icon name="quote" size={12} />
              <span>Cited in the overview</span>
            </h3>
            {details.citations.map((sentence, index) => (
              <p key={index} className={styles.sentence}>
                {displayUntrusted(sentence.text)}
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
