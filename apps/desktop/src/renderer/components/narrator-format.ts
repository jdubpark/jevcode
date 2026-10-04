import type { NarratorAvailability, NarratorCallRecord } from "../../shared/narrator-log.js";

/** What leaves the machine: only an "on" narrator sends anything (spec §6.2, E15). */
export function narratorSettingNote(availability: NarratorAvailability): string {
  switch (availability) {
    case "on":
      // Lane 07 fix I-1: the session explainer sends session text, redacted as the README paragraph is. Final review
      // C M-1, F item 5: overviewNarrative re-sends each component's current purpose, decisionWhy the decision's options.
      return "Sends to Claude Haiku: file paths, component and symbol names, dependency names, import edges and counts, package descriptions, the first README paragraph, earlier component descriptions, and session text (the task prompt, step headlines, decision titles, options and answers, and short agent messages). Package descriptions, README and session text are sent after secrets are redacted. File contents are never sent.";
    case "off_setting":
      return "Rule-based labels only. Nothing leaves this machine.";
    case "off_no_key":
      return "No Anthropic key is set (add one under Settings → API keys), so labels stay rule-based. Nothing leaves this machine.";
    case "off_env":
      return "JEVCODE_NARRATOR=off, so labels stay rule-based. Nothing leaves this machine.";
  }
}

export function narratorAvailabilityLabel(availability: NarratorAvailability): string {
  switch (availability) {
    case "on":
      return "Narrator on · claude-haiku-4-5";
    case "off_setting":
      return "Off in Settings";
    case "off_no_key":
      return "Off · no Anthropic key";
    case "off_env":
      return "Off · JEVCODE_NARRATOR=off";
  }
}

export interface NarratorCallRow {
  id: string;
  question: string;
  status: string;
  counts: string;
  latency: string;
  cost: string;
  model: string;
}

export function narratorCallRow(record: NarratorCallRecord): NarratorCallRow {
  const question =
    record.question === "describeComponents"
      ? `describe ×${record.batchSize}`
      : record.question === "overviewNarrative"
        ? "overview"
        : record.question;
  const status =
    record.error !== null ? record.error : record.discarded ? "discarded" : record.dropped > 0 ? "partial" : "ok";
  return {
    id: record.id,
    question,
    status,
    counts: `${record.accepted}/${record.accepted + record.dropped}`,
    latency: record.ms < 1000 ? `${record.ms} ms` : `${(record.ms / 1000).toFixed(1)} s`,
    cost: record.costUsd === null ? "—" : `$${record.costUsd.toFixed(4)}`,
    model: record.model,
  };
}
