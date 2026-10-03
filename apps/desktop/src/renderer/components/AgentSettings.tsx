import { useState } from "react";

import {
  AGENT_MODEL_OPTIONS,
  REASONING_EFFORT_OPTIONS,
} from "../../shared/prefs.js";
import type { NarratorAvailability } from "../../shared/narrator-log.js";
import { narratorSettingNote } from "./narrator-format.js";
import type {
  AgentModelOption,
  AgentPreferences,
  AgentPreferencesPatch,
  ReasoningEffortOption,
} from "../../shared/prefs.js";

import { Glyph } from "./glyph.js";

interface AgentSettingsProps {
  prefs: AgentPreferences;
  /** Main's narrator availability (preferences:get / preferences:updated); absent falls back to the setting. */
  narratorAvailability?: NarratorAvailability | undefined;
  onSet: (patch: AgentPreferencesPatch) => void;
}

export function AgentSettings(props: AgentSettingsProps) {
  const { prefs } = props;
  const [open, setOpen] = useState(false);
  // Spec §10: the note says what leaves the machine, so it follows main's availability (setting,
  // key and JEVCODE_NARRATOR). Without it, the setting decides.
  const availability: NarratorAvailability =
    props.narratorAvailability ?? (prefs.explainWithModel ? "on" : "off_setting");
  const budgetUnknown = prefs.usageBudgetFraction === null;
  const budgetPercent = budgetUnknown
    ? null
    : Math.round(Number(prefs.usageBudgetFraction) * 100);

  return (
    <section className="agent-settings">
      {open ? (
        <div id="agent-settings-body" className="agent-settings-body">
      <label className="agent-settings-row">
        <span>Model</span>
        <select
          value={prefs.model}
          onChange={(event) =>
            props.onSet({ model: event.target.value as AgentModelOption })
          }
        >
          {AGENT_MODEL_OPTIONS.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label className="agent-settings-row">
        <span>Reasoning</span>
        <select
          value={prefs.reasoningEffort}
          onChange={(event) =>
            props.onSet({
              reasoningEffort: event.target.value as ReasoningEffortOption,
            })
          }
        >
          {REASONING_EFFORT_OPTIONS.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
      <div className="agent-settings-row">
        <span>Usage budget</span>
        <label className="budget-unknown">
          <input
            type="checkbox"
            checked={budgetUnknown}
            onChange={(event) =>
              props.onSet({
                usageBudgetFraction: event.target.checked ? null : "0.40",
              })
            }
          />
          unknown
        </label>
      </div>
      <input
        className="budget-slider"
        type="range"
        min={0}
        max={100}
        step={5}
        value={budgetPercent ?? 40}
        disabled={budgetUnknown}
        onChange={(event) =>
          props.onSet({
            usageBudgetFraction: (Number(event.target.value) / 100).toFixed(2),
          })
        }
      />
      <div className="budget-value">
        {budgetUnknown ? "unknown (assumes 40%)" : `${budgetPercent}%`}
      </div>
      <label className="agent-settings-row narrator-setting">
        <span>Explain with a model</span>
        <input
          type="checkbox"
          checked={prefs.explainWithModel}
          aria-describedby="narrator-setting-note"
          onChange={(event) => props.onSet({ explainWithModel: event.target.checked })}
        />
      </label>
      <p id="narrator-setting-note" className="narrator-note">
        {narratorSettingNote(availability)}
      </p>
        </div>
      ) : null}
      <button
        type="button"
        className={`side-row${open ? " on" : ""}`}
        aria-expanded={open}
        aria-controls="agent-settings-body"
        onClick={() => setOpen((value) => !value)}
      >
        <Glyph name="list" />
        <span className="side-label">Agent settings</span>
      </button>
    </section>
  );
}
