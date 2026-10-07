import { contextBridge, ipcRenderer } from "electron";

/** Spike A only: hands scrcpy packets from the main process to the decoding page. */
contextBridge.exposeInMainWorld("spikeBridge", {
  onPacket(cb: (p: unknown) => void) {
    ipcRenderer.on("scrcpy:packet", (_e, p) => cb(p));
  },
});
