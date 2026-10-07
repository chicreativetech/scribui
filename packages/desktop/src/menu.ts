import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { openProjects } from "./projectWindow.js";
import { explainFailure, openAndRemember, pickAndOpen, recent, showLauncher } from "./launcherWindow.js";

/**
 * The app menu. No zoom items: zoom would apply to whichever page has focus,
 * and the app's page is sized by the canvas.
 */
export function buildMenu() {
  const mac = process.platform === "darwin";
  const focusedProject = () => {
    const w = BrowserWindow.getFocusedWindow();
    return openProjects().find((p) => p.win === w) ?? null;
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const picked = await pickAndOpen(BrowserWindow.getFocusedWindow());
            if (picked) explainFailure(picked.result);
          },
        },
        {
          label: "Open Recent",
          submenu: recent.list().length
            ? recent
                .list()
                .slice(0, 10)
                .map((p) => ({ label: `${p.name}  —  ${p.dir}`, click: async () => explainFailure(await openAndRemember(p.dir)) }))
            : [{ label: "No recent projects", enabled: false }],
        },
        { label: "Projects…", accelerator: "CmdOrCtrl+Shift+O", click: () => showLauncher() },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload Canvas", accelerator: "CmdOrCtrl+Shift+R", click: () => focusedProject()?.win.webContents.reload() },
        { label: "Reload App", accelerator: "CmdOrCtrl+R", click: () => focusedProject()?.live.reload() },
        { type: "separator" },
        { label: "Developer Tools for App", accelerator: mac ? "Alt+Cmd+J" : "Ctrl+Shift+J", click: () => focusedProject()?.live.openDevTools() },
        { label: "Developer Tools for Canvas", accelerator: mac ? "Alt+Cmd+I" : "Ctrl+Shift+I", click: () => focusedProject()?.win.webContents.openDevTools({ mode: "detach" }) },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Rebuild after the recent list changes. */
export function refreshMenu() {
  if (app.isReady()) buildMenu();
}
