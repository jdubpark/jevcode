import type { NarratorAvailability, NarratorCallRecord } from "../../shared/narrator-log.js";

/** What leaves the machine: only an "on" narrator sends anything (spec §6.2, E15). */
export function narratorSettingNote(availability: NarratorAvailability): string {
  switch (availability) {
    case "on":
      return "Sends file paths, symbol names and the first README paragraph to Claude Haiku. File contents are never sent.";
    case "off_setting":
      return "Rule-based labels only. Nothing leaves this machine.";
    case "off_no_key":
      return "ANTHROPIC_API_KEY is not set, so labels stay rule-based. Nothing leaves this machine.";
    case "off_env":
      return "JEVCODE_NARRATOR=off, so labels stay rule-based. Nothing leaves this machine.";
  }
}

export function narratorAvailabilityLabel(availability: NarratorAvailability): string {
  switch (availability) {
    case "on":
      return "Narrator on · claude-haiku-4-5";
    case "off_setting":
      return "Off in Agent settings";
    case "off_no_key":
      return "Off · ANTHROPIC_API_KEY is not set";
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
