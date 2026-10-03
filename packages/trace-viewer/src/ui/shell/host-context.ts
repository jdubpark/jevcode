import { createContext, useContext } from "react";

import type { ViewerHost } from "./host.js";

/** The host's actions for views (deviation 11): the Console's decision block calls answerDecision. */
export const ViewerHostContext = createContext<ViewerHost>({});

export function useViewerHost(): ViewerHost {
  return useContext(ViewerHostContext);
}
