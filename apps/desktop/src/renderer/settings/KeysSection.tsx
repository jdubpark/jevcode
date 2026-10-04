import { useId, useRef, useState } from "react";

import { CANNOT_ENCRYPT_MESSAGE } from "../../shared/secrets.js";
import type { ApiKeyName, KeyStatus, KeyTestResult, SecretsView } from "../../shared/secrets.js";
import { Glyph } from "../components/glyph.js";
import { keyPurpose, keyStatusLine, keyTestLine, keyTitle } from "./settings-format.js";

export interface KeysApi {
  set(name: ApiKeyName, value: string): Promise<SecretsView>;
  remove(name: ApiKeyName): Promise<SecretsView>;
  test(name: "ANTHROPIC_API_KEY"): Promise<KeyTestResult>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save the key.";
}

function KeyRow({ status, canSave, api }: { status: KeyStatus; canSave: boolean; api: KeysApi }) {
  const titleId = useId();
  // Uncontrolled on purpose: a controlled field mirrors its value into the DOM's value attribute, and React state
  // would hold the key. Only whether the field has text is kept; the value is read once, at Save.
  const field = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [filled, setFilled] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const title = keyTitle(status.name);

  // Closing the form unmounts the field, which drops what was typed.
  const closeForm = () => {
    setEditing(false);
    setFilled(false);
    setMessage(null);
  };

  const save = async () => {
    try {
      await api.set(status.name, field.current?.value ?? "");
      closeForm();
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  return (
    <div className="settings-key" role="group" aria-labelledby={titleId}>
      <div className="settings-key-head">
        <Glyph name="key" />
        <span id={titleId} className="settings-key-title">
          {title}
        </span>
        <span className="settings-key-purpose">{keyPurpose(status.name)}</span>
      </div>
      <p className="settings-key-status" aria-live="polite">
        {keyStatusLine(status)}
      </p>
      {editing ? (
        <form
          className="settings-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            ref={field}
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${title} key`}
            onChange={(event) => setFilled(event.target.value.trim() !== "")}
          />
          <button type="submit" className="settings-button primary" disabled={!filled}>
            Save
          </button>
          <button type="button" className="settings-button" onClick={closeForm}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="settings-key-actions">
          <button type="button" className="settings-button" disabled={!canSave} onClick={() => setEditing(true)}>
            {status.set ? "Replace" : "Add"}
          </button>
          {status.source === "app" ? (
            <button
              type="button"
              className="settings-button"
              onClick={() =>
                void api
                  .remove(status.name)
                  // A test result described the removed key, not the one active next.
                  .then(() => setMessage(null))
                  .catch((error: unknown) => setMessage(errorText(error)))
              }
            >
              Remove
            </button>
          ) : null}
          {status.name === "ANTHROPIC_API_KEY" ? (
            <button
              type="button"
              className="settings-button"
              disabled={!status.set || testing}
              onClick={() => {
                setTesting(true);
                void api
                  .test("ANTHROPIC_API_KEY")
                  .then((result) => setMessage(keyTestLine(result)))
                  .catch(() => setMessage("The check failed"))
                  .finally(() => setTesting(false));
              }}
            >
              Test
            </button>
          ) : null}
        </div>
      )}
      {message !== null ? <p className="settings-key-message" role="status">{message}</p> : null}
    </div>
  );
}

export function KeysSection({ view, api }: { view: SecretsView; api: KeysApi }) {
  return (
    <section className="settings-section" aria-labelledby="settings-keys-title">
      <h2 id="settings-keys-title">API keys</h2>
      {!view.canSave ? <p className="settings-note">{CANNOT_ENCRYPT_MESSAGE}</p> : null}
      {view.fileUnreadable ? <p className="settings-note">Saved keys could not be read; save them again.</p> : null}
      {view.keys.map((status) => (
        <KeyRow key={status.name} status={status} canSave={view.canSave} api={api} />
      ))}
    </section>
  );
}
