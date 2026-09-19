import type { JevcodeApi } from "../shared/api.js";

export function getBridge(): JevcodeApi {
  if (!window.jevcode) {
    throw new Error("window.jevcode is unavailable; preload failed to load");
  }
  return window.jevcode;
}
