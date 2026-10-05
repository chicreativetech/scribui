import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  AGENT_SECTION,
  androidFlowHelper,
  androidFlowScript,
  Annotation,
  AnnotationsFile,
  SCREENS_GUIDE_FILE,
  screensGuide,
  starterManifest,
  PRODUCT,
  RULES_HEADER,
  ScreenCapture,
  ScreenManifest,
  StatusFile,
  upsertAgentSection,
  type Platform,
  type RoundState,
} from "@intentcue/core";

export const pad = (n: number) => String(n).padStart(3, "0");

export class RoundLockedError extends Error {
  constructor(round: number, status: string) {
    super(`round ${round} is ${status}; sent rounds are immutable`);
  }
}

/** All reads and writes of the `.intentcue/` folder. */
export class ReviewStore {
  readonly root: string;
  readonly dir: string;

  constructor(projectDir: string) {
    this.root = resolve(projectDir);
    this.dir = join(this.root, PRODUCT.folder);
  }

  exists() {
    return existsSync(this.dir);
  }

  path(...p: string[]) {
    return join(this.dir, ...p);
  }

  roundDir(n: number) {
    return this.path("rounds", pad(n));
  }

  /* ─────────────── init ─────────────── */

  /**
   * Create the folder contract: screens.json (starter), the format guide for the
   * agent, rules.md, flows/ (with the Android helper), and the AGENTS.md section.
   * Existing files are kept. Returns the paths it created or updated.
   */
  async init(opts: { platform: Platform; name?: string; baseUrl?: string; appId?: string; build?: string }): Promise<string[]> {
    const created: string[] = [];
    const rel = (p: string) => `${PRODUCT.folder}/${p}`;
    const write = async (p: string, content: string, mode?: number) => {
      if (existsSync(this.path(p))) return;
      await writeFile(this.path(p), content, mode ? { mode } : undefined);
      created.push(rel(p));
    };
    await mkdir(this.path("flows"), { recursive: true });
    await mkdir(this.path("rounds"), { recursive: true });

    const name = opts.name ?? basename(this.root);
    if (!existsSync(this.path("screens.json"))) {
      const body = JSON.stringify(starterManifest(opts.platform, name, opts), null, 2) + "\n";
      await write("screens.json", body);
      // remember the starter so we can tell when the agent has filled it in
      await writeFile(this.path(".starter"), createHash("sha1").update(body).digest("hex") + "\n");
    }
    await write(SCREENS_GUIDE_FILE, screensGuide(opts.platform, opts));
    if (opts.platform === "android") {
      await write("flows/adb.mjs", androidFlowHelper(opts.appId ?? "com.example.app"));
      await write("flows/home.sh", androidFlowScript([]), 0o755);
    } else if (opts.platform === "ios") {
      await write("flows/home.yaml", `appId: ${opts.appId ?? "com.example.app"}\n---\n- launchApp\n`);
    }
    await write("rules.md", RULES_HEADER);

    // agent instructions
    const targets = ["AGENTS.md"];
    if (existsSync(join(this.root, "CLAUDE.md"))) targets.push("CLAUDE.md");
    for (const f of targets) {
      const p = join(this.root, f);
      const before = existsSync(p) ? await readFile(p, "utf8") : null;
      const after = upsertAgentSection(before);
      if (after !== before) {
        await writeFile(p, after);
        created.push(before === null ? f : `${f} (updated)`);
      }
    }
    return created;
  }

  /** True while screens.json is still exactly the starter written by init. */
  async isStarterManifest(): Promise<boolean> {
    try {
      const want = (await readFile(this.path(".starter"), "utf8")).trim();
      const body = await readFile(this.path("screens.json"), "utf8");
      return createHash("sha1").update(body).digest("hex") === want;
    } catch {
      return false;
    }
  }

  /** Merge fields into screens.json's "app" object, keeping everything else as written. */
  async updateApp(patch: Record<string, unknown>) {
    const wasStarter = await this.isStarterManifest();
    const raw = JSON.parse(await readFile(this.path("screens.json"), "utf8")) as { app: Record<string, unknown> };
    raw.app = { ...raw.app, ...patch };
    await writeJson(this.path("screens.json"), raw);
    // our own edit doesn't count as the agent filling in the screens
    if (wasStarter) {
      const body = await readFile(this.path("screens.json"), "utf8");
      await writeFile(this.path(".starter"), createHash("sha1").update(body).digest("hex") + "\n");
    }
  }

  /**
   * Add a screen to screens.json, or replace the one with the same id. The
   * starter's example screen goes away with the first real one.
   */
  async upsertScreen(entry: ScreenManifest["screens"][number]) {
    const starter = await this.isStarterManifest();
    const raw = JSON.parse(await readFile(this.path("screens.json"), "utf8")) as { screens?: { id: string }[] };
    const screens = starter ? [] : (raw.screens ?? []);
    const i = screens.findIndex((s) => s.id === entry.id);
    if (i >= 0) screens[i] = entry;
    else screens.push(entry);
    raw.screens = screens;
    await writeJson(this.path("screens.json"), raw);
  }

  agentSection() {
    return AGENT_SECTION;
  }

  /* ─────────────── manifest ─────────────── */

  async readManifest(): Promise<ScreenManifest> {
    const p = this.path("screens.json");
    if (!existsSync(p)) throw new Error(`${PRODUCT.folder}/screens.json not found. Run: npx intentcue init`);
    const raw = JSON.parse(await readFile(p, "utf8"));
    const parsed = ScreenManifest.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`${PRODUCT.folder}/screens.json is invalid:\n${issues}`);
    }
    return parsed.data;
  }

  /* ─────────────── rounds ─────────────── */

  async listRounds(): Promise<number[]> {
    const d = this.path("rounds");
    if (!existsSync(d)) return [];
    const names = await readdir(d);
    return names
      .filter((n) => /^\d{3,}$/.test(n))
      .map(Number)
      .sort((a, b) => a - b);
  }

  async latestRound(): Promise<number | null> {
    const l = this.path("latest");
    try {
      const target = await readlink(l);
      const m = /(\d{3,})\/?$/.exec(target);
      if (m) return Number(m[1]);
    } catch {
      try {
        const txt = (await readFile(l, "utf8")).trim();
        const m = /(\d{3,})\/?$/.exec(txt);
        if (m) return Number(m[1]);
      } catch {
        /* no pointer */
      }
    }
    const all = await this.listRounds();
    return all.length ? all[all.length - 1]! : null;
  }

  private async pointLatest(n: number) {
    const l = this.path("latest");
    const target = join("rounds", pad(n));
    const tmp = this.path(`.latest-${process.pid}`);
    await rm(tmp, { force: true, recursive: true });
    try {
      await symlink(target, tmp, process.platform === "win32" ? "junction" : "dir");
    } catch {
      await writeFile(tmp, target + "\n");
    }
    await rm(l, { force: true, recursive: false }).catch(() => {});
    await rename(tmp, l);
  }

  async createRound(): Promise<number> {
    const rounds = await this.listRounds();
    const n = (rounds[rounds.length - 1] ?? 0) + 1;
    const dir = this.roundDir(n);
    for (const sub of ["screens", "trees", "ink"]) await mkdir(join(dir, sub), { recursive: true });
    const now = new Date().toISOString();
    await this.writeStatus(n, { round: n, status: "capturing", createdAt: now, updatedAt: now, screens: [] });
    await writeJson(join(dir, "annotations.json"), { version: 1, round: n, annotations: [] });
    await this.pointLatest(n);
    return n;
  }

  async readStatus(n: number): Promise<StatusFile> {
    const raw = JSON.parse(await readFile(join(this.roundDir(n), "status.json"), "utf8"));
    return StatusFile.parse(raw);
  }

  async writeStatus(n: number, s: StatusFile) {
    await writeJson(join(this.roundDir(n), "status.json"), s);
  }

  async setStatus(n: number, status: RoundState, extra: Partial<StatusFile> = {}) {
    const cur = await this.readStatus(n);
    const now = new Date().toISOString();
    const next: StatusFile = { ...cur, ...extra, status, updatedAt: now };
    if (status === "sent") next.sentAt = now;
    if (status === "applied") next.appliedAt = now;
    await this.writeStatus(n, next);
    return next;
  }

  async statusMtime(n: number): Promise<number> {
    try {
      return (await stat(join(this.roundDir(n), "status.json"))).mtimeMs;
    } catch {
      return 0;
    }
  }

  /* ─────────────── captures ─────────────── */

  async writeCapture(n: number, c: ScreenCapture) {
    await writeJson(join(this.roundDir(n), "trees", `${c.screenId}.json`), c);
  }

  async readCapture(n: number, screenId: string): Promise<ScreenCapture | null> {
    const p = join(this.roundDir(n), "trees", `${safeId(screenId)}.json`);
    if (!existsSync(p)) return null;
    return ScreenCapture.parse(JSON.parse(await readFile(p, "utf8")));
  }

  async readCaptures(n: number): Promise<Map<string, ScreenCapture>> {
    const dir = join(this.roundDir(n), "trees");
    const out = new Map<string, ScreenCapture>();
    if (!existsSync(dir)) return out;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()) {
      const c = await this.readCapture(n, f.slice(0, -5));
      if (c) out.set(c.screenId, c);
    }
    return out;
  }

  /**
   * Remove a screen from an open round: its screenshot and tree, its status
   * entry, the notes on it (and arrows or rules pointing at it), and its
   * screens.json entry. Earlier rounds keep their copy. Returns how many notes
   * were removed.
   */
  async removeScreen(n: number, id: string): Promise<{ notes: number }> {
    const st = await this.readStatus(n);
    if (st.status === "sent" || st.status === "applied") throw new RoundLockedError(n, st.status);
    if (st.status === "capturing") throw new Error(`round ${n} is being captured; try again when it's done`);
    const sid = safeId(id);
    await rm(join(this.roundDir(n), "screens", `${sid}.png`), { force: true });
    await rm(join(this.roundDir(n), "trees", `${sid}.json`), { force: true });
    await this.writeStatus(n, { ...st, updatedAt: new Date().toISOString(), screens: (st.screens ?? []).filter((s) => s.screenId !== id) });

    const before = await this.readAnnotations(n);
    const after = before
      .filter((a) => a.screenId !== id && !(a.geometry.type === "arrow" && a.geometry.toScreenId === id))
      .map((a) => (a.kind === "rule" && a.targets ? { ...a, targets: a.targets.filter((t) => !t.startsWith(`${id}#`)) } : a));
    await this.writeAnnotations(n, after);

    const raw = JSON.parse(await readFile(this.path("screens.json"), "utf8")) as { screens?: { id: string }[] };
    if (raw.screens?.some((s) => s.id === id)) {
      raw.screens = raw.screens.filter((s) => s.id !== id);
      await writeJson(this.path("screens.json"), raw);
    }
    return { notes: before.length - after.length };
  }

  /* ─────────────── annotations ─────────────── */

  async readAnnotations(n: number): Promise<Annotation[]> {
    const p = join(this.roundDir(n), "annotations.json");
    if (!existsSync(p)) return [];
    return AnnotationsFile.parse(JSON.parse(await readFile(p, "utf8"))).annotations;
  }

  async writeAnnotations(n: number, annotations: Annotation[], opts: { force?: boolean } = {}) {
    if (!opts.force) {
      const s = await this.readStatus(n);
      if (s.status === "sent" || s.status === "applied") throw new RoundLockedError(n, s.status);
    }
    const file: AnnotationsFile = { version: 1, round: n, annotations };
    await writeJson(join(this.roundDir(n), "annotations.json"), file);
  }

  /* ─────────────── rules ─────────────── */

  /** Append-only: human edits above are left untouched. */
  async appendRules(md: string, heading: string) {
    if (!md.trim()) return;
    const p = this.path("rules.md");
    const cur = existsSync(p) ? await readFile(p, "utf8") : RULES_HEADER;
    if (!existsSync(p)) await writeFile(p, cur);
    const sep = cur.endsWith("\n\n") ? "" : cur.endsWith("\n") ? "\n" : "\n\n";
    await appendFile(p, `${sep}## ${heading}\n\n${md}`);
  }

  async readText(rel: string): Promise<string | null> {
    const p = this.safePath(rel);
    if (!p || !existsSync(p)) return null;
    return readFile(p, "utf8");
  }

  /** Resolve a path inside `.intentcue/`, or null if it escapes. */
  safePath(rel: string): string | null {
    const p = resolve(this.dir, rel);
    const r = relative(this.dir, p);
    if (r.startsWith("..") || resolve(r) === r) return null;
    return p;
  }
}

export const safeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, "_");

export async function writeJson(p: string, data: unknown) {
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, p);
}
