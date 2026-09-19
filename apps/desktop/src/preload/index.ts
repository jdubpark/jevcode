import { contextBridge, ipcRenderer } from "electron";

import { createJevcodeApi } from "../shared/api.js";

const api = createJevcodeApi({
  platform: process.platform,
  invoke: (channel, payload) =>
    ipcRenderer.invoke(channel, payload) as Promise<unknown>,
  on: (channel, listener) => {
    const wrapped = (_event: unknown, payload: unknown) => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
});

contextBridge.exposeInMainWorld("jevcode", api);
