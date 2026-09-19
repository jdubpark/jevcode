export type AuthFailureKind =
  | "not_signed_in"
  | "unauthorized"
  | "out_of_credits";

export interface AuthFailure {
  kind: AuthFailureKind;
  message: string;
}

const AUTH_PATTERNS: { kind: AuthFailureKind; pattern: RegExp }[] = [
  {
    kind: "not_signed_in",
    pattern:
      /not signed in|run [`'"“]?codex login|login required|no credentials|not logged in|log in to use codex/i,
  },
  { kind: "out_of_credits", pattern: /out of credits|insufficient credits|credit limit reached/i },
  {
    kind: "unauthorized",
    pattern: /401 unauthorized|missing bearer|unauthorized/i,
  },
];

const AUTH_MESSAGES: Record<AuthFailureKind, string> = {
  not_signed_in: "codex is not signed in; run `codex login` and retry",
  unauthorized: "codex authentication failed (401 Unauthorized)",
  out_of_credits: "codex workspace is out of credits",
};

export function detectAuthFailure(text: string): AuthFailure | null {
  for (const { kind, pattern } of AUTH_PATTERNS) {
    if (pattern.test(text)) {
      return { kind, message: AUTH_MESSAGES[kind] };
    }
  }
  return null;
}
