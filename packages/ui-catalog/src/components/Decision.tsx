import { useActions } from "@json-render/react";

import type { AnswerDecisionParams, DecisionProps } from "@jevcode/contracts";

export function Decision({ props }: { props: DecisionProps }) {
  const { execute } = useActions();
  const answerRef = props.actions?.find((a) => a.action === "answer_decision");
  const delegateRef = props.actions?.find(
    (a) => a.action === "delegate_decision",
  );
  const answerParams = answerRef?.params as AnswerDecisionParams | undefined;
  const decisionKey =
    answerParams !== undefined && Object.keys(answerParams.decision).length > 0
      ? (Object.keys(answerParams.decision)[0] ?? "decision")
      : "decision";
  const decisionId = answerParams?.decisionId ?? props.decisionId;
  const evidence = answerParams?.evidence;

  const choose = (optionId: string) => {
    const params: Record<string, unknown> = {
      decisionId,
      decision: { [decisionKey]: optionId },
    };
    if (evidence !== undefined) {
      params.evidence = evidence;
    }
    void execute({ action: "answer_decision", params });
  };

  const delegate = () => {
    void execute({
      action: "delegate_decision",
      params: {
        decisionId:
          (delegateRef?.params as { decisionId?: string } | undefined)
            ?.decisionId ?? props.decisionId,
      },
    });
  };

  return (
    <div className="jevcode-decision" data-testid="decision">
      <span className="jevcode-severity" data-severity={props.severity}>
        {props.severity}
      </span>
      <h3 className="jevcode-title">{props.title}</h3>
      <p className="jevcode-context">{props.context}</p>
      <div className="jevcode-options">
        {props.options.map((option) => (
          <div
            key={option.id}
            className="jevcode-option"
            data-option-id={option.id}
          >
            <div className="jevcode-option-head">
              <span className="jevcode-option-label">{option.label}</span>
              <button
                type="button"
                data-testid={`choose-${option.id}`}
                onClick={() => choose(option.id)}
              >
                Choose
              </button>
            </div>
            <p className="jevcode-option-description">{option.description}</p>
            {option.tradeoffs !== undefined && option.tradeoffs.length > 0 ? (
              <table
                className="jevcode-tradeoffs"
                data-testid={`tradeoffs-${option.id}`}
              >
                <thead>
                  <tr>
                    <th>dimension</th>
                    <th>consequence</th>
                  </tr>
                </thead>
                <tbody>
                  {option.tradeoffs.map((tradeoff, index) => (
                    <tr key={index}>
                      <td>{tradeoff.dimension}</td>
                      <td>{tradeoff.consequence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="jevcode-delegate"
        data-testid="delegate"
        onClick={delegate}
      >
        Let the agent decide
      </button>
    </div>
  );
}
