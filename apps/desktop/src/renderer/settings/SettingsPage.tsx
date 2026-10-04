import { useEffect, useRef, useState } from "react";

import type { AgentPreferencesPatch, PreferencesView } from "../../shared/prefs.js";
import type { SecretsView } from "../../shared/secrets.js";
import { getBridge } from "../bridge.js";
import { Glyph } from "../components/glyph.js";
import { FeaturesSection } from "./FeaturesSection.js";
import { KeysSection } from "./KeysSection.js";

/** Keys that scroll the page natively when focus rests on <body>; they must keep doing that. */
const SCROLL_KEYS = new Set([" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

export interface SettingsPageProps {
  prefs: PreferencesView;
  onSetPrefs: (patch: AgentPreferencesPatch) => void;
  onClose: () => void;
}

export function SettingsPage({ prefs, onSetPrefs, onClose }: SettingsPageProps) {
  const bridge = getBridge();
  const heading = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState<SecretsView | null>(null);

  useEffect(() => {
    heading.current?.focus();
    void bridge.secrets.view().then(setView).catch(() => undefined);
    return bridge.onSecretsUpdated(setView);
  }, [bridge]);

  // Window capture phase runs before the viewer's KeyboardLayer (window, bubble phase), which skips prevented events.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      // The hidden viewer treats every key aimed at <body> as its own (j, Alt+1 changing its level, Cmd/Ctrl+C copying
      // a review note), so none may reach its window listener: Back must find it as it was. Stopping here keeps native
      // actions: Tab, scrolling keys and modified keys (Cmd/Ctrl+C copies a real selection) are not prevented. App's
      // own shortcuts listen on window in the capture phase too, so stopPropagation leaves them running.
      const target = event.target;
      const atBody = target === null || target === document.body || target === document.documentElement || target === window;
      if (!atBody) return;
      event.stopPropagation();
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (!modified && event.key !== "Tab" && !SCROLL_KEYS.has(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <section className="settings-page" data-settings-page="" aria-labelledby="settings-title">
      <header className="settings-header">
        <button type="button" className="settings-back" data-settings-back="" onClick={onClose}>
          <Glyph name="back" />
          Back
        </button>
        <h1 id="settings-title" ref={heading} tabIndex={-1}>
          Settings
        </h1>
      </header>
      {view !== null ? <KeysSection view={view} api={bridge.secrets} /> : null}
      <FeaturesSection prefs={prefs} onSet={onSetPrefs} />
    </section>
  );
}
