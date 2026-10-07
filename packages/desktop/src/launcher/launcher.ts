/**
 * The projects window: recent projects, "Open folder…", the capture tools
 * found on this machine (installed from here when the app can), and the
 * setup of a folder that isn't a ScribUI project yet. Talks to the main
 * process only through `window.scribuiLauncher` (launcherPreload).
 */

type Platform = "ios" | "android" | "web";
type Project = { dir: string; name: string; platform: Platform | null; openedAt: string; exists: boolean; open: boolean; display: string };
type Tool = {
  id: string;
  name: string;
  purpose: string;
  platforms: Platform[];
  required: boolean;
  ok: boolean;
  detail: string;
  install?: { command?: string; url?: string; auto?: { does: string; terms?: string; after?: string }; note?: string };
};
type OpenResult =
  | { ok: true }
  | { ok: false; error: string; hint?: string; dir?: string }
  | { ok: false; setup: true; error: string; dir: string }
  | { ok: false; canceled: true };
type InstallResult = { ok: true; after?: string } | { ok: false; error: string };
type SetupInfo = {
  dir: string;
  display: string;
  name: string;
  detected: Platform;
  found: Record<Platform, string | null>;
  iosAvailable: boolean;
  android?: { appId?: string; build?: string };
  ios?: { bundleId?: string; build?: string };
  warning: string | null;
};
type UpdateState =
  | { status: "off" | "idle" | "checking" | "none"; current?: string }
  | { status: "available"; version: string; auto: boolean }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };
type Server = { url: string; running: boolean; title: string | null };

declare global {
  interface Window {
    scribuiLauncher: {
      version: string;
      os: string;
      list(): Promise<Project[]>;
      open(dir: string): Promise<OpenResult>;
      pick(): Promise<OpenResult>;
      remove(dir: string): Promise<Project[]>;
      tools(): Promise<Tool[]>;
      install(id: string): Promise<InstallResult>;
      cancelInstall(id: string): Promise<void>;
      copy(text: string): Promise<void>;
      openLink(url: string): Promise<void>;
      onChange(cb: () => void): void;
      onInstallLog(cb: (e: { id: string; line: string }) => void): void;
      update(): Promise<UpdateState>;
      updateAction(action: "install" | "check" | "open"): Promise<void>;
      onUpdate(cb: (s: UpdateState) => void): void;
      setup: {
        info(dir: string): Promise<SetupInfo>;
        servers(dir: string): Promise<Server[]>;
        checkUrl(url: string): Promise<{ url: string | null; running: boolean }>;
        tools(dir: string, platform: Platform): Promise<Tool[]>;
        /** Set the folder up and open it. */
        create(dir: string, answers: unknown): Promise<OpenResult & { created?: string[] }>;
        cancel(dir: string): Promise<void>;
        onStart(cb: (dir: string) => void): void;
      };
    };
  }
}

const api = window.scribuiLauncher;
const $ = (id: string) => document.getElementById(id)!;
const errors = new Map<string, { error: string; hint?: string }>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(k);
  return e;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86_400 * 30) return `${Math.round(s / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

const platformName = (p: Platform) => (p === "ios" ? "iOS" : p === "android" ? "Android" : "Web");

function link(text: string, url: string) {
  const a = el("a", { href: "#", textContent: text });
  a.addEventListener("click", (e) => {
    e.preventDefault();
    void api.openLink(url);
  });
  return a;
}

function copyButton(text: string, label = "Copy") {
  const b = el("button", { className: "btn", textContent: label });
  b.addEventListener("click", async () => {
    await api.copy(text);
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = label), 1500);
  });
  return b;
}

/* ─────────────────────────── projects ─────────────────────────── */

async function renderProjects() {
  const list = await api.list();
  const ul = $("projects");
  ul.replaceChildren();
  if (!list.length) {
    ul.append(el("li", { className: "empty" }, "No projects yet. Open your app's folder to set ScribUI up there."));
    return;
  }
  for (const p of list) {
    const err = errors.get(p.dir);
    const remove = el("button", { className: "remove", title: "remove from this list", textContent: "×" });
    remove.setAttribute("aria-label", `remove ${p.name} from the list`);
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      errors.delete(p.dir);
      await api.remove(p.dir);
      void renderProjects();
    });
    const li = el(
      "li",
      { className: `project ${p.exists ? "" : "missing"}`, tabIndex: p.exists ? 0 : -1, title: p.exists ? `open ${p.dir}` : `${p.dir} no longer exists` },
      el("span", { className: "name", textContent: p.name }),
      el(
        "span",
        { className: "meta" },
        p.exists ? null : el("span", { className: "tag missing", textContent: "missing" }),
        p.open ? el("span", { className: "tag open", textContent: "open" }) : null,
        p.platform ? el("span", { className: "tag", textContent: p.platform }) : null,
        ago(p.openedAt),
      ),
      remove,
      el("span", { className: "path", textContent: `‎${p.display}` }),
      err ? el("span", { className: "error", textContent: `${err.error}${err.hint ? ` ${err.hint}` : ""}` }) : null,
    );
    const open = async () => {
      if (!p.exists) return;
      li.style.opacity = "0.6";
      const r = await api.open(p.dir);
      li.style.opacity = "";
      handleOpen(r, p.dir);
    };
    li.addEventListener("click", () => void open());
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void open();
    });
    ul.append(li);
  }
}

/** After opening: an error stays on the project's row; a folder that isn't set up goes to setup. */
function handleOpen(r: OpenResult, dir?: string) {
  if (r.ok) {
    if (dir) errors.delete(dir);
  } else if ("setup" in r) {
    void startSetup(r.dir);
    return;
  } else if (!("canceled" in r) && (r.dir ?? dir)) errors.set((r.dir ?? dir)!, { error: r.error, ...(r.hint ? { hint: r.hint } : {}) });
  void renderProjects();
}

/* ─────────────────────────── tools ─────────────────────────── */

/** Installs running or finished in this window, by tool: their output and how they ended. */
const installs = new Map<string, { lines: string[]; running: boolean; result?: InstallResult }>();
const logBoxes = new Map<string, Set<HTMLElement>>();

api.onInstallLog(({ id, line }) => {
  const st = installs.get(id);
  if (!st) return;
  st.lines.push(line);
  if (st.lines.length > 200) st.lines.splice(0, st.lines.length - 200);
  for (const box of logBoxes.get(id) ?? []) fillLog(box, st.lines);
});

function fillLog(box: HTMLElement, lines: string[]) {
  box.textContent = lines.slice(-8).join("\n");
  box.scrollTop = box.scrollHeight;
}

/** One tool: found (where), or missing with the app's Install button, or what to do instead. `refresh` re-checks after an install. */
function toolRow(t: Tool, refresh: () => void): HTMLElement {
  const forWhat = t.platforms.map(platformName).join(", ");
  const detail = el("div", { className: "detail" });
  if (t.ok) detail.append(el("span", { className: "path", textContent: t.detail }));
  else {
    detail.append(t.detail);
    const auto = t.install?.auto;
    const st = installs.get(t.id);
    if (auto) {
      const box = el("pre", { className: "log" });
      const btn = el("button", { className: "btn primary", textContent: st?.running ? "Installing…" : "Install" });
      btn.disabled = !!st?.running;
      const cancel = el("button", { className: "btn", textContent: "Cancel" });
      cancel.hidden = !st?.running;
      cancel.addEventListener("click", () => void api.cancelInstall(t.id));
      btn.addEventListener("click", async () => {
        const run = { lines: [] as string[], running: true };
        installs.set(t.id, run);
        btn.disabled = true;
        btn.textContent = "Installing…";
        cancel.hidden = false;
        box.hidden = false;
        fillLog(box, run.lines);
        const r = await api.install(t.id);
        Object.assign(run, { running: false, result: r });
        refresh();
      });
      detail.append(
        el("div", { className: "does" }, auto.does, auto.terms ? " " : null, auto.terms ? link("Terms", auto.terms) : null),
        el("div", { className: "install" }, btn, cancel, t.install?.url ? link("about", t.install.url) : null),
      );
      if (st && (st.running || st.lines.length)) fillLog(box, st.lines);
      else box.hidden = true;
      detail.append(box);
      if (!logBoxes.has(t.id)) logBoxes.set(t.id, new Set());
      logBoxes.get(t.id)!.add(box);
      if (st?.result && !st.result.ok) detail.append(el("div", { className: "error", textContent: `Install failed: ${st.result.error}` }));
    } else {
      if (t.install?.note) detail.append(el("div", { className: "does", textContent: t.install.note }));
      if (t.install?.command)
        detail.append(el("div", { className: "install" }, el("code", { textContent: t.install.command }), copyButton(t.install.command), t.install.url ? link("how to", t.install.url) : null));
      else if (t.install?.url) detail.append(el("div", { className: "install" }, link("how to install", t.install.url)));
    }
  }
  const after = installs.get(t.id)?.result;
  if (t.ok && after?.ok && after.after) detail.append(el("div", { className: "does", textContent: after.after }));
  return el(
    "div",
    { className: `tool ${t.ok ? "" : "missing"} ${t.required ? "required" : ""}` },
    el("span", { className: "dot", title: t.ok ? "found" : "missing" }),
    el("div", { className: "tname", textContent: t.name }, el("small", { textContent: `${forWhat}${t.required ? " · needed" : " · optional"}` })),
    el("div", {}, el("div", { textContent: t.purpose, className: "purpose" }), detail),
  );
}

function resetLogBoxes() {
  for (const set of logBoxes.values()) for (const b of [...set]) if (!b.isConnected) set.delete(b);
}

async function renderTools() {
  const box = $("tools");
  const btn = $("recheck") as HTMLButtonElement;
  btn.disabled = true;
  if (!box.childElementCount) box.replaceChildren(el("div", { className: "checking", textContent: "Checking…" }));
  const tools = await api.tools();
  btn.disabled = false;
  box.replaceChildren(...tools.map((t) => toolRow(t, () => void renderTools())));
  resetLogBoxes();
}

/* ─────────────────────────── setup ─────────────────────────── */

type Step = "platform" | "app" | "tools";

type Setup = {
  dir: string;
  info: SetupInfo;
  step: Step;
  platform: Platform;
  /** Web: the chosen URL, or "other" with `custom`. */
  url: string | null;
  custom: string;
  servers: Server[] | null;
  appId: string;
  build: string;
  tools: Tool[] | null;
  error: string | null;
  busy: boolean;
};

let setup: Setup | null = null;

const STEPS: Step[] = ["platform", "app", "tools"];
const STEP_NAMES: Record<Step, string> = { platform: "Platform", app: "App", tools: "Tools" };

async function startSetup(dir: string) {
  const info = await api.setup.info(dir);
  setup = {
    dir,
    info,
    step: "platform",
    platform: info.detected,
    url: null,
    custom: "",
    servers: null,
    appId: "",
    build: "",
    tools: null,
    error: null,
    busy: false,
  };
  fillMobileDefaults(setup);
  $("home").hidden = true;
  $("setup").hidden = false;
  renderSetup();
}

/** The detected id and build command for the chosen mobile platform. */
function fillMobileDefaults(s: Setup) {
  const found = s.platform === "android" ? s.info.android : s.platform === "ios" ? { appId: s.info.ios?.bundleId, build: s.info.ios?.build } : null;
  s.appId = found?.appId ?? "";
  s.build = found?.build ?? "";
}

function leaveSetup() {
  if (setup) void api.setup.cancel(setup.dir);
  setup = null;
  $("setup").hidden = true;
  $("home").hidden = false;
  void renderProjects();
  void renderTools();
}

function go(step: Step) {
  if (!setup) return;
  setup.step = step;
  setup.error = null;
  renderSetup();
}

function renderSetup() {
  const s = setup;
  if (!s) return;
  const steps = STEPS;
  const at = steps.indexOf(s.step);
  const root = $("setup");
  const body = el("div", { className: "body" });
  const foot = el("div", { className: "foot" });

  root.replaceChildren(
    el(
      "section",
      {},
      el(
        "div",
        { className: "head" },
        el("h2", {}, `Set up ScribUI in ${s.info.name}`, el("span", { className: "sub path", textContent: `‎${s.info.display}` })),
        (() => {
          const b = el("button", { className: "btn", textContent: "Cancel" });
          b.addEventListener("click", leaveSetup);
          return b;
        })(),
      ),
      el(
        "ol",
        { className: "steps" },
        ...steps.map((st, i) => el("li", { className: i < at ? "done" : i === at ? "now" : "" }, el("span", { className: "n", textContent: i < at ? "✓" : String(i + 1) }), STEP_NAMES[st])),
      ),
      s.info.warning && s.step === "platform" ? el("div", { className: "banner warn", textContent: s.info.warning }) : null,
      body,
      s.error ? el("div", { className: "banner error", textContent: s.error }) : null,
      foot,
    ),
  );

  const back = (to: Step) => {
    const b = el("button", { className: "btn", textContent: "Back" });
    b.addEventListener("click", () => go(to));
    return b;
  };
  const next = (label: string, fn: () => void, enabled = true) => {
    const b = el("button", { className: "btn primary", textContent: label });
    b.disabled = !enabled || s.busy;
    b.addEventListener("click", fn);
    return b;
  };

  if (s.step === "platform") {
    body.append(el("p", { className: "lead", textContent: "Which app do you want to review?" }), platformCards(s));
    foot.append(el("span", { className: "spacer" }), next("Continue", () => go("app")));
  } else if (s.step === "app") {
    if (s.platform === "web") webApp(s, body);
    else mobileApp(s, body);
    foot.append(back("platform"), el("span", { className: "spacer" }), next("Continue", () => checkApp(s)));
  } else if (s.step === "tools") {
    toolsStep(s, body);
    const missing = (s.tools ?? []).filter((t) => t.required && !t.ok);
    const label = "Create and open";
    const btn = next(missing.length ? `${label} without ${missing.map((t) => t.name).join(" and ")}` : label, () => void create(s), !!s.tools);
    if (missing.length) btn.classList.remove("primary");
    foot.append(back("app"), el("span", { className: "spacer" }), btn);
  }
}

function platformCards(s: Setup): HTMLElement {
  const box = el("div", { className: "cards", role: "radiogroup" });
  const options: { p: Platform; title: string; sub: string; off?: string }[] = [
    { p: "web", title: "Web", sub: "A site or web app, shown in the app's own browser" },
    { p: "android", title: "Android", sub: "An emulator, or a phone over USB" },
    { p: "ios", title: "iOS", sub: "The iOS Simulator", ...(s.info.iosAvailable ? {} : { off: "needs a Mac with Xcode" }) },
  ];
  for (const o of options) {
    const found = s.info.found[o.p];
    const card = el(
      "button",
      { className: `card ${s.platform === o.p ? "on" : ""}`, disabled: !!o.off },
      el("span", { className: "ctitle" }, o.title, s.info.detected === o.p && found ? el("span", { className: "tag open", textContent: "detected" }) : null),
      el("span", { className: "csub", textContent: o.off ?? o.sub }),
      found ? el("span", { className: "cfound path", textContent: found }) : null,
    );
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(s.platform === o.p));
    card.addEventListener("click", () => {
      if (s.platform === o.p) return;
      s.platform = o.p;
      s.tools = null;
      fillMobileDefaults(s);
      renderSetup();
    });
    card.addEventListener("dblclick", () => go("app"));
    box.append(card);
  }
  return box;
}

function webApp(s: Setup, body: HTMLElement) {
  const list = el("div", { className: "choices" });
  const custom = el("input", { type: "text", placeholder: "port or URL, e.g. 3000 or http://localhost:3000", value: s.custom, spellcheck: false });
  custom.addEventListener("input", () => {
    s.custom = custom.value;
    s.url = "other";
    list.querySelectorAll<HTMLInputElement>("input[type=radio]").forEach((r) => (r.checked = r.value === "other"));
  });
  custom.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void checkApp(s);
  });
  const rescan = el("button", { className: "linkbtn", textContent: "Look again" });
  rescan.addEventListener("click", () => {
    s.servers = null;
    fill();
  });
  body.append(
    el("p", { className: "lead", textContent: "Where does your app run?" }),
    el("p", { className: "hint", textContent: "Its dev server's address. It doesn't need to be running yet; start it before you capture." }),
    list,
    el("div", { className: "rescan" }, rescan),
  );

  const radio = (value: string, label: Node | string, hint: string | null, extra?: HTMLElement) => {
    const input = el("input", { type: "radio", name: "url", value, checked: s.url === value });
    input.addEventListener("change", () => {
      s.url = value;
      if (value === "other") custom.focus();
    });
    return el("label", { className: "choice" }, input, el("span", { className: "clabel" }, label), hint ? el("span", { className: "chint", textContent: hint }) : null, extra ?? null);
  };

  const fill = async () => {
    list.replaceChildren(el("div", { className: "checking", textContent: "Looking for running dev servers…" }));
    if (!s.servers) s.servers = await api.setup.servers(s.dir);
    if (setup !== s || s.step !== "app") return;
    if (s.url === null) s.url = s.servers.find((x) => x.running)?.url ?? s.servers[0]?.url ?? "other";
    list.replaceChildren(
      ...s.servers.map((x) =>
        radio(x.url, el("code", { textContent: x.url.replace(/^https?:\/\//, "") }), x.running ? `running${x.title ? ` · ${x.title}` : ""}` : "not running yet"),
      ),
      radio("other", "Other", null, custom),
    );
    if (s.url === "other") custom.focus();
  };
  void fill();
}

function mobileApp(s: Setup, body: HTMLElement) {
  const ios = s.platform === "ios";
  const field = (label: string, hint: string, value: string, placeholder: string, set: (v: string) => void) => {
    const input = el("input", { type: "text", value, placeholder, spellcheck: false });
    input.addEventListener("input", () => set(input.value));
    return el("label", { className: "field" }, el("span", { className: "flabel", textContent: label }), input, el("span", { className: "hint", textContent: hint }));
  };
  body.append(
    el("p", { className: "lead", textContent: `Your ${platformName(s.platform)} app` }),
    field(
      ios ? "Bundle id" : "Application id",
      `Opens the app before each screen is captured. ${ios ? "Xcode: target → General → Bundle Identifier." : "build.gradle: applicationId."}${(ios ? s.info.ios?.bundleId : s.info.android?.appId) ? " Found in the project." : ""}`,
      s.appId,
      "com.example.app",
      (v) => (s.appId = v),
    ),
    field("Build command (optional)", "Builds and installs the app when it isn't on the device yet.", s.build, ios ? "npx expo run:ios" : "./gradlew installDebug", (v) => (s.build = v)),
  );
}

/** Check the app step's answers before moving on (the main process checks them again when creating). */
async function checkApp(s: Setup) {
  if (s.platform === "web") {
    const raw = s.url === "other" || s.url === null ? s.custom : s.url;
    const r = await api.setup.checkUrl(raw);
    if (!r.url) {
      s.error = "Enter a port (3000) or a URL (http://localhost:3000).";
      return renderSetup();
    }
    if (s.url === "other") s.custom = r.url;
  } else if (s.appId.trim() && !/^[A-Za-z][\w-]*(\.[A-Za-z0-9_-]+)+$/.test(s.appId.trim())) {
    s.error = `"${s.appId.trim()}" isn't an app id (like com.example.app).`;
    return renderSetup();
  }
  go("tools");
}

function toolsStep(s: Setup, body: HTMLElement) {
  const box = el("div", { className: "tools-list" });
  const recheck = el("button", { className: "linkbtn", textContent: "Check again" });
  body.append(
    el("p", { className: "lead", textContent: s.platform === "web" ? "Tools for capturing web screens" : `Tools for capturing ${platformName(s.platform)} screens` }),
    el(
      "p",
      { className: "hint", textContent: s.platform === "web" ? "Views you capture in the app need nothing more. Playwright recaptures the screens on its own when their code changes." : "Install what's missing here, or later from the projects window." },
    ),
    box,
    el("div", { className: "rescan" }, recheck),
  );
  const fill = async (fresh: boolean) => {
    if (fresh || !s.tools) {
      box.replaceChildren(el("div", { className: "checking", textContent: "Checking…" }));
      s.tools = await api.setup.tools(s.dir, s.platform);
      if (setup !== s || s.step !== "tools") return;
      // the footer's button depends on what's missing
      return renderSetup();
    }
    box.replaceChildren(...s.tools.map((t) => toolRow(t, () => void fill(true))));
    resetLogBoxes();
  };
  recheck.addEventListener("click", () => void fill(true));
  void fill(false);
}

async function create(s: Setup) {
  s.busy = true;
  s.error = null;
  renderSetup();
  const raw = s.url === "other" || s.url === null ? s.custom : s.url;
  const r = await api.setup.create(s.dir, { platform: s.platform, ...(s.platform === "web" ? { baseUrl: raw } : { appId: s.appId, build: s.build }) });
  s.busy = false;
  if (r.ok) {
    // the project's window is open; this window closes or goes back to the list
    setup = null;
    $("setup").hidden = true;
    $("home").hidden = false;
    void renderProjects();
    return;
  }
  s.error = "error" in r ? r.error : "Couldn't set the project up.";
  renderSetup();
}

/* ─────────────────────────── start ─────────────────────────── */

$("open").addEventListener("click", async () => handleOpen(await api.pick()));
$("recheck").addEventListener("click", () => void renderTools());
/** The footer: this version, and an update when there is one. */
function renderUpdate(st: UpdateState) {
  const foot = $("version");
  const action = (label: string, what: "install" | "check" | "open") => {
    const b = el("button", { className: "linkbtn", textContent: label });
    b.addEventListener("click", () => void api.updateAction(what));
    return b;
  };
  const parts: (Node | string)[] = [`ScribUI ${api.version}`];
  if (st.status === "ready") parts.push(" · ", el("strong", { textContent: `${st.version} is ready` }), " ", action("Restart to update", "install"));
  else if (st.status === "downloading") parts.push(` · downloading ${st.version} (${st.percent} %)`);
  else if (st.status === "available") parts.push(` · ${st.version} is out `, st.auto ? "" : action("Download", "open"));
  else if (st.status !== "off") parts.push(" · ", action("Check for updates", "check"));
  foot.replaceChildren(...parts);
}
void api.update().then(renderUpdate);
api.onUpdate(renderUpdate);
api.onChange(() => void renderProjects());
api.setup.onStart((dir) => void startSetup(dir));
window.addEventListener("focus", () => {
  if (!setup) void renderProjects();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && setup && !setup.busy) leaveSetup();
});

void renderProjects();
void renderTools();

export {};
