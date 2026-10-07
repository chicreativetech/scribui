import { installEnv, installPlan, runInstall, type InstallableTool } from "@scribui/capture";

/**
 * Tool installs started from the app (the projects window, setup, the device
 * tab). One install per tool at a time: a second request for the same tool
 * joins the running one and gets its output from then on.
 */

export const INSTALLABLE: readonly InstallableTool[] = ["adb", "emulator", "xcode", "axe", "playwright"];
export const isInstallable = (v: unknown): v is InstallableTool => typeof v === "string" && (INSTALLABLE as readonly string[]).includes(v);

export type InstallResult = { ok: true; after?: string } | { ok: false; error: string };

type Running = { done: Promise<InstallResult>; listeners: Set<(line: string) => void>; controller: AbortController };
const running = new Map<InstallableTool, Running>();

export function installTool(id: InstallableTool, onLine: (line: string) => void): Promise<InstallResult> {
  const now = running.get(id);
  if (now) {
    now.listeners.add(onLine);
    return now.done.finally(() => now.listeners.delete(onLine));
  }
  const listeners = new Set([onLine]);
  const controller = new AbortController();
  const done = (async (): Promise<InstallResult> => {
    // the plan is made here, from this machine, never from what the window sent
    const plan = installPlan(id, await installEnv());
    const r = await runInstall(plan, (l) => listeners.forEach((fn) => fn(l)), controller.signal);
    return r.ok ? { ok: true, ...(plan.auto && plan.after ? { after: plan.after } : {}) } : r;
  })().finally(() => running.delete(id));
  running.set(id, { done, listeners, controller });
  return done;
}

export function cancelInstall(id: InstallableTool) {
  running.get(id)?.controller.abort();
}

/** Quitting stops installs that are still running (a half-done download is cleaned up by the next try). */
export function cancelAllInstalls() {
  for (const r of running.values()) r.controller.abort();
}
