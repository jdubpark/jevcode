/** Bidi controls (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F) and C0 controls other than \t.
 *  All are single UTF-16 code units. Checked by code, not by a regex, because ESLint's
 *  no-control-regex rejects control ranges in patterns. */
function isUntrustedCode(code: number): boolean {
  if (code < 0x20) return code !== 0x09;
  return (
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Private W1 stand-in for the model's single-line `displayUntrusted` (spec §6.8, UI index §1.4
 * B-1). The W1 boundary keeps lane B's runtime out of C1a until B merges; at the C1a completion
 * rebase this file is deleted and the glyphs import `displayUntrusted` from `../../model/index.js`.
 * Same contract: each bidi or control character becomes a visible ⟨U+XXXX⟩ token, so agent text
 * cannot reorder a path or command the supervisor reads. The token holds no such character, so
 * the call is idempotent and text a caller already passed through the model's function is unchanged.
 */
export function displayUntrusted(text: string): string {
  let result = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!isUntrustedCode(code)) continue;
    result += `${text.slice(start, index)}⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
    start = index + 1;
  }
  return start === 0 ? text : result + text.slice(start);
}
