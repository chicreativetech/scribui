import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { reportProblem, showCrashFiles } from "./crashes.js";
import { checkNow, installNow, onUpdateState, RELEASES, updateState } from "./updates.js";
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
    {
      role: "help",
      submenu: [
        ...(updateState().status === "ready"
          ? [{ label: `Restart to Update to ${(updateState() as { version: string }).version}`, click: () => installNow() }]
          : []),
        { label: "Check for Updates…", click: () => void checkNow(BrowserWindow.getFocusedWindow()) },
        { label: "Release Notes", click: () => void shell.openExternal(`${RELEASES}/tag/v${app.getVersion()}`) },
        { type: "separator" },
        { label: "Report a Problem…", click: () => reportProblem() },
        { label: "Show Logs and Crash Reports", click: () => showCrashFiles() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// a downloaded update adds "Restart to Update" to the Help menu
onUpdateState((st) => {
  if (st.status === "ready") refreshMenu();
});

/** Rebuild after the recent list changes. */
export function refreshMenu() {
  if (app.isReady()) buildMenu();
}
