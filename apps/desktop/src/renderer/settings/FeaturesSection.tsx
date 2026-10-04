import { AGENT_BACKEND_OPTIONS, AGENT_MODEL_OPTIONS, JEV_CLIENT_OPTIONS, REASONING_EFFORT_OPTIONS } from "../../shared/prefs.js";
import type { AgentBackendOption, AgentModelOption, AgentPreferencesPatch, JevClientOption, PreferencesView, ReasoningEffortOption } from "../../shared/prefs.js";
import type { NarratorAvailability } from "../../shared/narrator-log.js";
import { narratorSettingNote } from "../components/narrator-format.js";
import { overrideNote } from "./settings-format.js";

const BACKEND_LABEL: Record<AgentBackendOption, string> = { auto: "Auto (Codex if installed)", codex: "Codex", mock: "Mock (scripted)" };
const JEV_LABEL: Record<JevClientOption, string> = { auto: "Auto (TypeSafe with a key)", typesafe: "TypeSafe", offline: "Offline (rule-based)" };

export function FeaturesSection({ prefs, onSet }: { prefs: PreferencesView; onSet: (patch: AgentPreferencesPatch) => void }) {
  // Spec §10: the note says what leaves the machine, so it follows main's availability (setting, key and
  // JEVCODE_NARRATOR). Without it, the setting decides.
  const availability: NarratorAvailability = prefs.narratorAvailability ?? (prefs.explainWithModel ? "on" : "off_setting");
  const budgetUnknown = prefs.usageBudgetFraction === null;
  const budgetPercent = budgetUnknown ? null : Math.round(Number(prefs.usageBudgetFraction) * 100);
  return (
    <section className="settings-section" aria-labelledby="settings-features-title">
      <h2 id="settings-features-title">Features</h2>

      <div className="settings-row">
        <label className="settings-switch">
          <input
            type="checkbox"
            checked={prefs.explainWithModel}
            disabled={availability === "off_env"}
            aria-describedby="settings-narrator-note"
            onChange={(event) => onSet({ explainWithModel: event.target.checked })}
          />
          <span>Explain with a model</span>
        </label>
        <p id="settings-narrator-note" className="settings-note">
          {narratorSettingNote(availability)}
        </p>
      </div>

      <div className="settings-row">
        <label htmlFor="settings-backend">Agent backend</label>
        <select
          id="settings-backend"
          value={prefs.agentBackend}
          disabled={prefs.agentBackendOverride !== undefined}
          onChange={(event) => onSet({ agentBackend: event.target.value as AgentBackendOption })}
        >
          {AGENT_BACKEND_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {BACKEND_LABEL[option]}
            </option>
          ))}
        </select>
        <p className="settings-note">
          {prefs.agentBackendOverride !== undefined ? overrideNote("JEVC_AGENT", prefs.agentBackendOverride) : "Applies to new sessions"}
        </p>
      </div>

      <div className="settings-row">
        <label htmlFor="settings-jev">Jev decisions</label>
        <select
          id="settings-jev"
          value={prefs.jevClient}
          disabled={prefs.jevClientOverride !== undefined}
          onChange={(event) => onSet({ jevClient: event.target.value as JevClientOption })}
        >
          {JEV_CLIENT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {JEV_LABEL[option]}
            </option>
          ))}
        </select>
        <p className="settings-note">
          {prefs.jevClientOverride !== undefined ? overrideNote("JEVC_JEV_CLIENT", prefs.jevClientOverride) : "Applies to new sessions"}
        </p>
      </div>

      <div className="settings-row">
        <label htmlFor="settings-model">Model</label>
        <select id="settings-model" value={prefs.model} onChange={(event) => onSet({ model: event.target.value as AgentModelOption })}>
          {AGENT_MODEL_OPTIONS.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <label htmlFor="settings-reasoning">Reasoning</label>
        <select
          id="settings-reasoning"
          value={prefs.reasoningEffort}
          onChange={(event) => onSet({ reasoningEffort: event.target.value as ReasoningEffortOption })}
        >
          {REASONING_EFFORT_OPTIONS.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <span>Usage budget</span>
        <label className="settings-inline">
          <input
            type="checkbox"
            aria-label="Usage budget unknown"
            checked={budgetUnknown}
            onChange={(event) => onSet({ usageBudgetFraction: event.target.checked ? null : "0.40" })}
          />
          unknown
        </label>
        <input
          className="settings-slider"
          type="range"
          min={0}
          max={100}
          step={5}
          aria-label="Usage budget"
          value={budgetPercent ?? 40}
          disabled={budgetUnknown}
          onChange={(event) => onSet({ usageBudgetFraction: (Number(event.target.value) / 100).toFixed(2) })}
        />
        <span className="settings-note">{budgetUnknown ? "unknown (assumes 40%)" : `${budgetPercent}%`}</span>
      </div>
    </section>
  );
}
