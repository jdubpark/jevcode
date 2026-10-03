import type { NarratorClient } from "@jevcode/jev-router";

import type { NarratorAvailability, NarratorCallRecord } from "../../shared/narrator-log.js";
import { createExplainerNarration } from "./explainer-narration.js";
import type { BriefSources, NarrationStatus } from "./explainer-narration.js";
import { blurbFrom, createFsBriefSources, EXPORTS_PER_COMPONENT } from "./explainer-narration-sources.js";
import type { ExplainerRegistry, NarrationContext, NarrationSeam, OverviewView } from "./explainer-stage.js";
import type { NarratorSwitch } from "./narrator-switch.js";

export interface NarrationSeamOptions {
  initialNarrator: NarratorClient | null;
  /** N-4 switch: tells "off" (setting) from "unavailable" (no key) for status.narrator (R2, R3). */
  narratorAvailability?(): NarratorAvailability;
  recordNarratorCall?(record: NarratorCallRecord): void;
  /** Tests and fixtures; the default reads the OverviewView plus the README on disk. */
  briefSources?: BriefSources;
  onStatus?(status: NarrationStatus): void;
}

/** Manifest description (redacted, clipped), else the README; exports from lane 04's parse pass. */
export function viewBriefSources(view: OverviewView, readmes: BriefSources): BriefSources {
  return {
    async blurb(component) {
      const description = view.manifest.descriptions[component.rootPath];
      if (description !== undefined && description.trim() !== "") return blurbFrom(description);
      return readmes.blurb(component);
    },
    async exports(component) {
      return [...view.exportsOf(component.id)].slice(0, EXPORTS_PER_COMPONENT);
    },
  };
}

/** R4: lane 04's ExplainerStageDeps.narration, built from createExplainerNarration. */
export function createNarrationSeamFactory(options: NarrationSeamOptions): (ctx: NarrationContext) => NarrationSeam {
  return (ctx) => {
    const disk = createFsBriefSources({ repoRoot: ctx.repoRoot });
    const narration = createExplainerNarration({
      db: ctx.db,
      repoRoot: ctx.repoRoot,
      narrator: options.initialNarrator,
      sources: options.briefSources ?? disk,
      refresh: () => ctx.refresh(),
      now: () => ctx.now(),
      schedule: ctx.schedule,
      log: (event) => ctx.log(event),
      ...(options.recordNarratorCall === undefined ? {} : { recordCall: options.recordNarratorCall }),
      ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
      ...(options.narratorAvailability === undefined ? {} : { narratorAvailability: options.narratorAvailability }),
    });
    return {
      textFor: (view) => narration.textFor(view.drafts),
      narrative: (snapshot) => narration.narrative(snapshot),
      onSnapshot: (snapshot, view) => narration.onSnapshot(snapshot, options.briefSources ?? viewBriefSources(view, disk)),
      setNarrator: (narrator) => narration.setNarrator(narrator),
      narratorStatus: () => narration.narratorStatus(),
      dispose: () => narration.dispose(),
    };
  };
}

/**
 * Spec E15: every change of the narrator switch reaches the open repo's stage, so switching the
 * setting off stops calls and aborts in-flight ones, and a lost or found reason (no key) reaches
 * status.narrator. A stage created later starts from `narratorSwitch.current()`. Returns the
 * unsubscribe function.
 */
export function connectNarratorSwitch(
  narratorSwitch: Pick<NarratorSwitch, "subscribe">,
  registry: Pick<ExplainerRegistry, "get">,
  openRepoRoot: () => string | undefined,
): () => void {
  return narratorSwitch.subscribe((client) => {
    const root = openRepoRoot();
    if (root !== undefined) registry.get(root)?.setNarrator(client);
  });
}
