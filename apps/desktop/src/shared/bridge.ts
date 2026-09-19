import type { JevcodeApi } from "./api.js";

declare global {
  interface Window {
    jevcode?: JevcodeApi;
  }
}

export type { JevcodeApi } from "./api.js";
