import { join } from "node:path";
import { app } from "electron";

/**
 * A development run (`electron .` from the repo) keeps its data apart from an
 * installed ScribUI: its own folder, so its own single-instance lock, recent
 * list and crash records. Otherwise it hands over to the installed app and
 * quits. Imported first in main.ts: other modules read the folder on load.
 */
if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "ScribUI Dev"));
// a fidelity or spike harness runs next to a development app that's open, with data of its own
if (process.env.SCRIBUI_FIDELITY || process.env.SCRIBUI_SPIKE) app.setPath("userData", join(app.getPath("appData"), "ScribUI Harness"));
// a test run (Playwright) next to a development app that's open: a folder of its own
if (!app.isPackaged && process.env.SCRIBUI_DEV_DATA) app.setPath("userData", process.env.SCRIBUI_DEV_DATA);
