export type ActionDispatcher = (
  action: string,
  params: Record<string, unknown>,
) => void | Promise<void>;

let actionDispatcher: ActionDispatcher | undefined;

export function setActionDispatcher(dispatcher: ActionDispatcher | undefined): void {
  actionDispatcher = dispatcher;
}

export function getActionDispatcher(): ActionDispatcher | undefined {
  return actionDispatcher;
}

export async function dispatchCatalogAction(
  action: string,
  params: Record<string, unknown>,
): Promise<void> {
  const dispatcher = getActionDispatcher();
  if (dispatcher === undefined) {
    throw new Error(
      `No action dispatcher registered for "${action}". Call setActionDispatcher() in the app shell, or mount ActionProvider with your own handlers.`,
    );
  }
  await dispatcher(action, params);
}
