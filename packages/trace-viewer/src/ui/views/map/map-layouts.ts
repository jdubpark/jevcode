import { createContext, useContext, useState } from "react";

import { createMapLayoutCache, type MapLayoutCache } from "../../../layout/map-layout.js";

/** The viewer's one sticky Map layout cache (lane 06 fix I-2), provided by TraceViewer and the test harnesses. */
export const MapLayoutCacheContext = createContext<MapLayoutCache | null>(null);

/** The viewer's layout cache, shared by the Map, its Fit and the Brief thumbnail; outside a viewer, a cache of the caller's own. */
export function useMapLayouts(): MapLayoutCache {
  const shared = useContext(MapLayoutCacheContext);
  const [own] = useState(createMapLayoutCache);
  return shared ?? own;
}
