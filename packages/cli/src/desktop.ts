import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "@scribui/capture";
import { DESKTOP_PROTOCOL, desktopOpenUrl } from "@scribui/core";
import type { ReviewStore } from "@scribui/server";
import { findOwner, type Owner } from "@scribui/project";

/**
 * Handing a project to the ScribUI desktop app when it's installed: the CLI
 * opens `scribui://open?dir=…`, the app takes the project (its lock and
 * server), and the CLI is done. SCRIBUI_DESKTOP=0 turns this off, =1 forces
 * it (an app registered from a dev checkout, which the checks below miss).
 */

/** Whether the desktop app is installed and registered for scribui:// links. */
export async function desktopInstalled(): Promise<boolean> {
  if (process.env.SCRIBUI_DESKTOP === "0") return false;
  if (process.env.SCRIBUI_DESKTOP === "1") return true;
  if (process.platform === "darwin") return ["/Applications/ScribUI.app", join(homedir(), "Applications/ScribUI.app")].some((p) => existsSync(p));
  if (process.platform === "win32") {
    for (const hive of ["HKCU", "HKLM"]) {
      const r = await run("reg", ["query", `${hive}\\Software\\Classes\\${DESKTOP_PROTOCOL}`], { timeoutMs: 5000 });
      if (r.code === 0) return true;
    }
    return false;
  }
  const r = await run("xdg-mime", ["query", "default", `x-scheme-handler/${DESKTOP_PROTOCOL}`], { timeoutMs: 5000 });
  return r.code === 0 && r.stdout.toString().trim().length > 0;
}

/** Ask the app to open the project; resolves with its server once it owns the project, null if it doesn't in time. */
export async function openInDesktop(store: ReviewStore, timeoutMs = 20_000): Promise<Owner | null> {
  const url = desktopOpenUrl(store.root);
  // Windows: not through cmd's `start`, which would expand the link's %-escapes as variables
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const owner = await findOwner(store);
    if (owner?.role === "server" && owner.app === "desktop" && owner.url) return owner;
  }
  return null;
}
