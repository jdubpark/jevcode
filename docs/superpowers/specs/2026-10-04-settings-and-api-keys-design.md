# Settings page and API keys: design

Date: 2026-10-04. Status: approved in conversation; this file is the written spec for review.

## Purpose

Today the desktop app reads its API keys only from the environment or a `.env` file at startup, and its few settings sit in a narrow panel at the bottom of the sidebar. The person wants to add and edit keys inside the app, and to turn features such as the narrator on and off from a proper settings page, without editing files or restarting.

Success means:

- A key pasted on the Settings page is stored securely and used at once (the narrator) or from the next session (the Jev decisions client), with no restart and no file edits.
- The page always shows which key is active and where it comes from, and never shows a saved key in full.
- Every setting the person chose is on one page: the narrator, the agent backend, the Jev decisions client, and the Codex model, reasoning effort and usage budget.

## Decisions (made with the person)

| Question | Decision |
|---|---|
| Where saved keys live | The OS keychain, through Electron `safeStorage`, in an encrypted file in the app's data folder. Never plaintext. |
| A key saved in the app and one in the environment or `.env` | The saved key wins; the environment key is the fallback. The page shows the source. |
| What the page covers | Narrator on/off, agent backend, Jev decisions client, Codex model, reasoning effort and usage budget. |
| Where the page lives | A Settings page in the main window, replacing the sidebar panel. |

Approaches considered for storage: Electron `safeStorage` with an encrypted file (chosen: no new native module, secrets stay out of the database); the `keytar` native module (rejected: another native build next to node-pty); encrypted values in the preferences table (rejected: secrets would sit in the database that trace exports and tests share).

## Scope

In scope: two keys, `ANTHROPIC_API_KEY` (narrator) and `TYPESAFE_API_KEY` (Jev decisions client; `JEV_API_KEY` stays an accepted environment alias); the settings listed above; the page; IPC; tests.

Out of scope: Codex sign-in (the Codex CLI manages it); other environment-only knobs (`JEVCODE_CODEX_BIN`, `JEVCODE_CODEX_SANDBOX_ARGS`, `JEVCODE_AGENT_STALL_MS`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`); syncing keys across machines; a key-validation call for TypeSafe (no free check endpoint is known).

## Behaviour

### Keys

- A secrets service in desktop main owns an allowlist of key names: `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`. Any other name is rejected.
- Saved values are encrypted with `safeStorage.encryptString` and written to `<userData>/secrets.json` as `{ version: 1, keys: { NAME: base64Ciphertext } }`, with file mode 0600. The file is written atomically (temporary file, then rename).
- The active value of a key is: the saved value if present, else the environment value (`process.env`, which already includes `.env`; for the TypeSafe key, `TYPESAFE_API_KEY` then the `JEV_API_KEY` alias), else none. Blank or whitespace-only values count as none.
- The window only ever receives a status per key: `{ name, set: boolean, source: "app" | "env" | "none", last4: string | null, envAlsoSet: boolean }`. `last4` is the last four characters of the active value. The full value never crosses IPC and is never logged; error messages never include it.
- If `safeStorage.isEncryptionAvailable()` is false, saving is refused with "This system cannot encrypt saved keys; set the key in the environment instead." Existing environment keys keep working. There is no plaintext fallback.
- If `secrets.json` is missing, it means no saved keys. If it is unreadable or a value fails to decrypt (for example after the keychain item was reset), that key reads as not saved, the page says "A saved key could not be read; save it again", and the file is left untouched until the next save of that key.
- Test (Anthropic only): a GET to `https://api.anthropic.com/v1/models` with the active key and the pinned base URL, a 10 s timeout and no retries. It costs no tokens and sends no project data. The result is `ok`, `unauthorized` (401/403), `unreachable` (network or timeout) or `error` with the HTTP status; the page shows it next to the key. Test never runs on its own; only the button triggers it.

### Applying changes

- Saving, replacing or removing `ANTHROPIC_API_KEY` updates the narrator switch at once: the old client is dropped, availability is recomputed (`on`, `off_setting`, `off_no_key`, `off_env`), and the explainer stage receives the new client through the existing `setNarrator` path. A call already in flight finishes or aborts as it does today.
- `TYPESAFE_API_KEY` and the Jev client choice apply to the next session: the runtime creates the Jev client per session, and it now reads keys through the secrets service. The page says "Applies to new sessions."
- The agent backend applies to the next session for the same reason.

### Settings and environment overrides

New stored preferences, beside the existing ones in the preferences table:

| Preference | Values | Default | Environment override |
|---|---|---|---|
| `agent.backend` | `auto`, `codex`, `mock` | `auto` | `JEVC_AGENT` (also accepts `replay`, environment only) |
| `jev.client` | `auto`, `typesafe`, `offline` | `auto` | `JEVC_JEV_CLIENT` (`degrade` is the environment name for offline) |
| `explainer.withModel` (exists) | on/off | on | `JEVCODE_NARRATOR=off` |

An environment override wins over the stored preference, so smokes, tests and scripted runs stay deterministic (the narrator's kill switch already works this way). When an override is active, the page disables that control and shows "Set by JEVC_AGENT=mock (environment)". Keys are the opposite: a saved key wins over the environment, as the person decided.

`auto` keeps today's meaning: the agent backend uses Codex when it is installed, else the scripted mock; the Jev client uses TypeSafe when its key is active, else offline.

## IPC

New channels, registered and validated like the existing ones (`apps/desktop/src/shared/ipc-registry.ts`):

| Channel | Payload | Reply |
|---|---|---|
| `secrets:status` | `{}` | `KeyStatus[]` |
| `secrets:set` | `{ name: AllowedKeyName, value: string }` | `KeyStatus[]` |
| `secrets:remove` | `{ name: AllowedKeyName }` | `KeyStatus[]` |
| `secrets:test` | `{ name: "ANTHROPIC_API_KEY" }` | `{ result: "ok" \| "unauthorized" \| "unreachable" \| "error"; status?: number }` |
| `preferences:get` / `set` / `updated` (exist) | gain `agentBackend`, `jevClient` and their override notes | `PreferencesView` |

Validation for `secrets:set`: the name is on the allowlist; the value is trimmed, non-empty, at most 512 characters, and contains no whitespace or control characters. A rejected value returns a typed error with no echo of the value. A `secrets:updated` push tells open windows to refresh statuses after any change.

`PreferencesView` gains `agentBackendOverride?: string` and `jevClientOverride?: string` (the environment value when it wins), next to the existing `narratorAvailability`.

## The page

- Opened from the sidebar's "Settings" row (the current "Agent settings" row, renamed) or Cmd+, (macOS) / Ctrl+, (elsewhere). It replaces the main area; "Back" or Esc returns to the session view exactly as it was. The sidebar panel's controls move here and the panel goes away.
- Two sections, in the app's light, restrained style (few borders, icon plus short text):
  - **API keys.** One row per key: name and purpose ("Anthropic: narrator descriptions and stories", "TypeSafe: Jev decisions"), a status line ("Saved in app · …a1b2", "From environment · …c3d4", "Not set", or "Saved in app · …a1b2 — overrides the environment key"), and actions: "Add" or "Replace" (opens a password field with Save and Cancel), "Remove" (only for a saved key), and "Test" (Anthropic only, with the result inline). Pasting and saving never echo the value; the field clears after Save.
  - **Features.** "Explain with a model" toggle with its status (on, off, no key, disabled by `JEVCODE_NARRATOR`) and the existing disclosure of what is sent; Agent backend (Auto, Codex, Mock); Jev decisions client (Auto, TypeSafe, Offline); Codex model, reasoning effort and usage budget. Controls that apply to new sessions say so.
- Accessibility: every control has a visible label; the key field is `type="password"` with `autocomplete="off"`; status changes are announced politely; focus moves to the page heading on open and back to the Settings row on close.

## Testing

- Secrets service: save, read, remove and status with a fake `safeStorage`; precedence (saved over environment, blank values ignored); encryption unavailable refuses to save; a corrupt file or a value that fails to decrypt reads as not saved; atomic write and file mode; the value never appears in logs or errors.
- IPC: allowlist, value validation, no echo in errors, `secrets:updated` fan-out.
- Narrator: saving or removing the Anthropic key changes availability and hands the explainer stage a new client or null, without a restart.
- Runtime: the Jev client and the agent backend follow stored preferences, environment overrides win, and keys come through the secrets service.
- Test button: a mocked HTTP layer for `ok`, 401, timeout and 500, never a real network call in tests.
- Renderer: the page never renders a full key; Add, Replace, Remove and Test flows; overridden controls are disabled with their note; Cmd+, opens and Esc closes; the sidebar panel's former controls work from the page.
- Electron smoke: open Settings once and take a screenshot at 1440 px, with `ANTHROPIC_API_KEY` empty and the narrator off as the smoke already sets.
