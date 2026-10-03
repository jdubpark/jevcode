import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";

import { catalogActionHandlers, registry } from "./registry.js";

export interface CatalogSurfaceProps {
  spec: Spec;
}

/**
 * Renders one catalog spec with its own json-render state and action context.
 *
 * Apps render catalog specs through this component, never through their own
 * @json-render/react import. pnpm installs one @json-render/react copy per zod
 * peer, so an app on another zod major resolves a different copy. Its
 * provider's context is a different object from the one the catalog
 * components read with useActions(), and they throw "useActions must be used
 * within an ActionProvider". Here the provider, the renderer and the
 * components share ui-catalog's copy.
 *
 * Button clicks go to the dispatcher set with setActionDispatcher().
 */
export function CatalogSurface({ spec }: CatalogSurfaceProps) {
  return (
    <JSONUIProvider registry={registry} handlers={catalogActionHandlers}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}
