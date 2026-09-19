import { useActions } from "@json-render/react";

import type { ActionRef } from "@jevcode/contracts";

const ACTION_LABELS: Record<string, string> = {
  answer_decision: "Answer decision",
  delegate_decision: "Let the agent decide",
  restore_previous_api_semantics: "Restore previous API semantics",
  inspect_call_sites: "Inspect call sites",
  show_exact_diff: "Show exact diff",
  accept_changes: "Accept changes",
  request_changes: "Request changes",
  continue_task: "Continue task",
  open_terminal: "Open terminal",
  interrupt_agent: "Interrupt agent",
  pin_surface: "Pin surface",
  dismiss_surface: "Dismiss",
};

export function ActionButtons({ actions }: { actions: ActionRef[] }) {
  const { execute } = useActions();
  return (
    <div className="jevcode-actions" data-testid="action-buttons">
      {actions.map((ref, index) => (
        <button
          key={`${ref.action}-${index}`}
          type="button"
          data-action={ref.action}
          onClick={() => {
            void execute({
              action: ref.action,
              params: ref.params as Record<string, unknown>,
            });
          }}
        >
          {ACTION_LABELS[ref.action] ?? ref.action}
        </button>
      ))}
    </div>
  );
}
