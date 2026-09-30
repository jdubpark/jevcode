import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { FINDING_TITLE } from "../inspector/finding-copy.js";
import { copyText } from "../inspector/Inspector.js";
import { buildReviewNote } from "../inspector/review-note.js";
import { resolveKey, type KeyCommand, type KeyInput } from "../state/keymap.js";
import { useViewStore } from "../state/store.js";
import type { Tool } from "../state/view-state.js";
import { useViewPortRegistry, ViewDefinitionsContext } from "../views/view-port.js";
import { useAnnounce } from "./LiveRegion.js";
import { markAfterPaint, PERF } from "./perf.js";
import {
  adjacentStep,
  focusRegion,
  hasTextSelection,
  isEditableTarget,
  nextInOrder,
  nextRegion,
  regionOf,
  REGIONS,
} from "./regions.js";
import { useSessionView } from "./session-context.js";
import { ShortcutSheet } from "./ShortcutSheet.js";

export interface KeyboardLayerProps {
  root: HTMLElement | null;
}

/** Elements that own Enter themselves; the layer's expand/collapse must not steal it. */
const OWNS_ENTER = 'button, a[href], summary, [role="tab"], [role="treeitem"], [role="button"], [role="slider"]';

function markKeyStart(timeStamp: number): void {
  try {
    performance.mark("tv:key-start", { startTime: timeStamp });
  } catch {
    // The HUD loses one sample; navigation is unaffected.
  }
}

/** One keyboard model for the whole viewer (spec §7.9). */
export function KeyboardLayer({ root }: KeyboardLayerProps) {
  const store = useViewStore();
  const registry = useViewPortRegistry();
  const sessionView = useSessionView();
  const views = useContext(ViewDefinitionsContext);
  const announce = useAnnounce();
  const [helpOpen, setHelpOpen] = useState(false);
  const latest = useRef({ sessionView, views, helpOpen, announce });
  latest.current = { sessionView, views, helpOpen, announce };
  const helpReturn = useRef<HTMLElement | null>(null);

  const closeHelp = useCallback((returnFocus: boolean) => {
    setHelpOpen(false);
    const target = helpReturn.current;
    helpReturn.current = null;
    if (returnFocus && target !== null && target.isConnected) target.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let follow = store.get().follow;
    let terminal = store.get().terminal;
    return store.subscribe(() => {
      const state = store.get();
      if (follow && !state.follow && !state.terminal) latest.current.announce("Live follow paused");
      if (!terminal && state.terminal) latest.current.announce("Session ended");
      follow = state.follow;
      terminal = state.terminal;
    });
  }, [store]);

  // The sheet is a non-modal dialog: a pointerdown outside it dismisses it and leaves focus alone.
  useEffect(() => {
    if (!helpOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('[role="dialog"]') !== null) return;
      closeHelp(false);
    };
    const doc = root?.ownerDocument ?? document;
    doc.addEventListener("pointerdown", onPointerDown);
    return () => doc.removeEventListener("pointerdown", onPointerDown);
  }, [helpOpen, closeHelp, root]);

  useEffect(() => {
    if (root === null) return undefined;
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    let pointerTarget: Element | null = null;
    let spaceHeld = false;
    let toolBeforeSpace: Tool = "select";

    const revealSelection = (): void => {
      const state = store.get();
      if (state.selection !== null) registry.get(state.view)?.reveal(state.selection, { animate: true });
    };

    const run = (command: KeyCommand, event: KeyboardEvent, target: Element | null): void => {
      const { sessionView: view, views: definitions } = latest.current;
      const state = store.get();
      const port = registry.get(state.view);
      switch (command.cmd) {
        case "item": {
          let next = nextInOrder(port?.readingOrder() ?? [], state.selection, command.dir, view.index);
          if (next === null && view.session !== null) {
            next = adjacentStep(view.session, view.index, state.selection, command.dir);
          }
          if (next === null) return;
          markKeyStart(event.timeStamp);
          store.dispatch({ type: "select", id: next, by: "shell" });
          port?.reveal(next, { animate: false });
          markAfterPaint(PERF.keyToPaint, "tv:key-start");
          return;
        }
        case "chapter":
        case "turn":
          store.dispatch({ type: "nav", target: command.cmd, dir: command.dir });
          revealSelection();
          return;
        case "finding": {
          store.dispatch({ type: "nav", target: "finding", dir: command.dir });
          const selected = store.get().selection;
          const findings = view.index.findingsBySeq;
          const position = findings.findIndex((finding) => finding.anchorStepId === selected);
          const finding = findings[position];
          if (finding !== undefined) {
            latest.current.announce(`Finding ${position + 1} of ${findings.length}: ${FINDING_TITLE[finding.ruleId]}`);
          }
          revealSelection();
          return;
        }
        case "toggle":
          if (target?.closest(OWNS_ENTER) != null) return;
          if (state.selection !== null) store.dispatch({ type: "expand/toggle", key: state.selection });
          return;
        case "esc":
          if (latest.current.helpOpen) {
            closeHelp(true);
            return;
          }
          store.dispatch({ type: "esc" });
          if (regionOf(doc.activeElement) === "inspector") port?.focusSelected();
          return;
        case "view": {
          const definition = definitions.find((item) => item.kind === command.view);
          if (definition === undefined || state.view === command.view) return;
          store.dispatch({ type: "view/switch", view: command.view });
          latest.current.announce(`${definition.label} view`);
          return;
        }
        case "level":
          store.dispatch({ type: "level/set", level: command.level, by: "shell" });
          return;
        case "playhead":
          store.dispatch({ type: "playhead/step", dir: command.dir });
          return;
        case "first":
          store.dispatch({ type: "nav/first" });
          revealSelection();
          return;
        case "last":
          store.dispatch({ type: "nav/last" });
          if (view.summary !== null && !view.terminal) store.dispatch({ type: "follow/set", follow: true });
          revealSelection();
          return;
        case "zoom":
          if (command.op === "in") port?.zoom.zoomIn();
          else if (command.op === "out") port?.zoom.zoomOut();
          else port?.zoom.resetToPreset();
          return;
        case "fit":
          if (command.target === "all") port?.zoom.fitAll();
          else port?.zoom.fitSelection();
          return;
        case "tool":
          store.dispatch({ type: "tool/set", tool: command.tool });
          return;
        case "space":
          if (command.down && !spaceHeld) {
            spaceHeld = true;
            toolBeforeSpace = state.tool;
            store.dispatch({ type: "tool/set", tool: "hand" });
          } else if (!command.down && spaceHeld) {
            spaceHeld = false;
            store.dispatch({ type: "tool/set", tool: toolBeforeSpace });
          }
          return;
        case "brushEdge":
          store.dispatch({ type: "brush/edge", edge: command.edge });
          return;
        case "brushChapter":
          store.dispatch({ type: "brush/chapter" });
          return;
        case "search":
          root.querySelector<HTMLInputElement>("[data-outline-search]")?.focus();
          return;
        case "help":
          if (latest.current.helpOpen) {
            closeHelp(true);
          } else {
            helpReturn.current = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
            setHelpOpen(true);
          }
          return;
        case "region": {
          // Absent or hidden regions are skipped.
          let region = nextRegion(regionOf(doc.activeElement), command.dir);
          for (let tries = 0; tries < REGIONS.length; tries += 1) {
            if (focusRegion(root, region)) return;
            region = nextRegion(region, command.dir);
          }
          return;
        }
        case "copyNote": {
          if (view.session === null || state.selection === null) return;
          const note = buildReviewNote(view.session, view.index, state.selection);
          void copyText(note.markdown).then((ok) =>
            latest.current.announce(ok ? "Review note copied" : "Could not copy the review note"),
          );
          return;
        }
      }
    };

    const releaseSpace = (): void => {
      if (!spaceHeld) return;
      spaceHeld = false;
      store.dispatch({ type: "tool/set", tool: toolBeforeSpace });
    };

    const handle = (event: KeyboardEvent, phase: "down" | "up"): void => {
      if (event.defaultPrevented) return;
      // Once Space is held its keyup always releases the hand tool, wherever the pointer or focus has moved.
      if (phase === "up" && spaceHeld && event.code === "Space") {
        event.preventDefault();
        releaseSpace();
        return;
      }
      // Esc inside an editable field closes only an open sheet; the field keeps Esc otherwise.
      if (phase === "down" && event.code === "Escape" && latest.current.helpOpen) {
        const editable = event.target instanceof Element && isEditableTarget(event.target);
        if (editable && root.contains(event.target as Element)) {
          event.preventDefault();
          closeHelp(true);
          return;
        }
      }
      const target = event.target instanceof Element ? event.target : null;
      const inside =
        target === null || target === doc.body || target === doc.documentElement || root.contains(target);
      if (!inside) return;
      const input: KeyInput = {
        code: event.code,
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.isComposing,
        editableTarget: isEditableTarget(target),
      };
      const pannable =
        regionOf(target) === "main" || (pointerTarget !== null && pointerTarget.closest("[data-pannable]") !== null);
      const command = resolveKey(
        input,
        { view: store.get().view, spaceOverPannable: pannable, hasTextSelection: hasTextSelection() },
        phase,
      );
      if (command === null) return;
      // Enter on a control that owns it stays with that control (no preventDefault, no toggle).
      if (command.cmd === "toggle" && target?.closest(OWNS_ENTER) != null) return;
      event.preventDefault();
      run(command, event, target);
    };

    const onKeyDown = (event: KeyboardEvent): void => handle(event, "down");
    const onKeyUp = (event: KeyboardEvent): void => handle(event, "up");
    const onPointerOver = (event: PointerEvent): void => {
      pointerTarget = event.target instanceof Element ? event.target : null;
    };
    const onPointerLeave = (): void => {
      pointerTarget = null;
    };
    win?.addEventListener("keydown", onKeyDown);
    win?.addEventListener("keyup", onKeyUp);
    win?.addEventListener("blur", releaseSpace);
    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerleave", onPointerLeave);
    return () => {
      win?.removeEventListener("keydown", onKeyDown);
      win?.removeEventListener("keyup", onKeyUp);
      win?.removeEventListener("blur", releaseSpace);
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [root, store, registry, closeHelp]);

  return helpOpen ? <ShortcutSheet onClose={() => closeHelp(true)} /> : null;
}
