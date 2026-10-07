import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Platform } from "@scribui/core";

/** Projects opened in the app, newest first, kept in the app's data folder. */

export type RecentProject = { dir: string; name: string; platform: Platform | null; openedAt: string };

const LIMIT = 20;

export class RecentProjects {
  constructor(private file: string) {}

  list(): RecentProject[] {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { projects?: RecentProject[] };
      return Array.isArray(data.projects) ? data.projects.filter((p) => p && typeof p.dir === "string") : [];
    } catch {
      return [];
    }
  }

  add(p: Omit<RecentProject, "openedAt">, now = new Date()): RecentProject[] {
    const next = [{ ...p, openedAt: now.toISOString() }, ...this.list().filter((x) => x.dir !== p.dir)].slice(0, LIMIT);
    this.write(next);
    return next;
  }

  remove(dir: string): RecentProject[] {
    const next = this.list().filter((x) => x.dir !== dir);
    this.write(next);
    return next;
  }

  private write(projects: RecentProject[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ projects }, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}
