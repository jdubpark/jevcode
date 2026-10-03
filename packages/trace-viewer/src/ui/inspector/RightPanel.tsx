import type { JSX } from "react";

import type { ViewerHost } from "../shell/host.js";
import { ErrorBoundary } from "../shell/ErrorBoundary.js";
import { useView } from "../state/store.js";
import { Brief } from "./Brief.js";
import { Inspector } from "./Inspector.js";

/** Spec §3.3, E4: the Brief whenever nothing is selected or Shift+B pinned it; the Inspector for a selection. */
export function RightPanel({ host }: { host: ViewerHost }): JSX.Element {
  const showBrief = useView((state) => state.selection === null || state.brief);
  return showBrief ? (
    <ErrorBoundary region="Brief">
      <Brief />
    </ErrorBoundary>
  ) : (
    <Inspector host={host} />
  );
}
