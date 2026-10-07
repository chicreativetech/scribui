/**
 * The projects window: recent projects, "Open folder…" and the device tools
 * found on this machine. Talks to the main process only through
 * `window.scribuiLauncher` (launcherPreload).
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
  install?: { command?: string; url?: string };
};
type OpenResult = { ok: true } | { ok: false; error: string; hint?: string; dir?: string } | { ok: false; canceled: true };

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
      copy(text: string): Promise<void>;
      openLink(url: string): Promise<void>;
      onChange(cb: () => void): void;
    };
  }
}

const api = window.scribuiLauncher;
const $ = (id: string) => document.getElementById(id)!;
const errors = new Map<string, { error: string; hint?: string }>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string | null)[]) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k !== null) e.append(k);
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

/** A hint's `code`-quoted parts as code, the rest as text. */
function richText(text: string): DocumentFragment {
  const f = document.createDocumentFragment();
  text.split(/(npx scribui)/).forEach((part, i) => f.append(i % 2 ? el("code", { textContent: part }) : part));
  return f;
}

async function renderProjects() {
  const list = await api.list();
  const ul = $("projects");
  ul.replaceChildren();
  if (!list.length) {
    ul.append(
      el(
        "li",
        { className: "empty" },
        "No projects yet. Open a folder where ScribUI is set up, or run ",
        el("code", { textContent: "npx scribui" }),
        " in your project first.",
      ),
    );
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
      err ? el("span", { className: "error" }, `${err.error} `, err.hint ? richText(err.hint) : "") : null,
    );
    const open = async () => {
      if (!p.exists) return;
      li.style.opacity = "0.6";
      const r = await api.open(p.dir);
      li.style.opacity = "";
      if (!r.ok && !("canceled" in r)) errors.set(p.dir, { error: r.error, ...(r.hint ? { hint: r.hint } : {}) });
      else errors.delete(p.dir);
      void renderProjects();
    };
    li.addEventListener("click", () => void open());
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void open();
    });
    ul.append(li);
  }
}

async function renderTools() {
  const box = $("tools");
  const btn = $("recheck") as HTMLButtonElement;
  btn.disabled = true;
  box.replaceChildren(el("div", { className: "checking", textContent: "Checking…" }));
  const tools = await api.tools();
  btn.disabled = false;
  box.replaceChildren(
    ...tools.map((t) => {
      const forWhat = t.platforms.map((p) => (p === "ios" ? "iOS" : p === "android" ? "Android" : "web")).join(", ");
      const detail = el("div", { className: "detail" });
      if (t.ok) detail.append(el("span", { className: "path", textContent: t.detail }));
      else {
        detail.append(t.detail);
        if (t.install?.command) {
          const code = el("code", { textContent: t.install.command });
          const copy = el("button", { className: "btn", textContent: "Copy" });
          copy.addEventListener("click", async () => {
            await api.copy(t.install!.command!);
            copy.textContent = "Copied";
            setTimeout(() => (copy.textContent = "Copy"), 1500);
          });
          const row = el("div", { className: "install" }, code, copy);
          if (t.install.url) {
            const a = el("a", { href: "#", textContent: "how to" });
            a.addEventListener("click", (e) => {
              e.preventDefault();
              void api.openLink(t.install!.url!);
            });
            row.append(a);
          }
          detail.append(row);
        }
      }
      return el(
        "div",
        { className: `tool ${t.ok ? "" : "missing"} ${t.required ? "required" : ""}` },
        el("span", { className: "dot", title: t.ok ? "found" : "missing" }),
        el("div", { className: "tname", textContent: t.name }, el("small", { textContent: `${forWhat}${t.required ? " · needed" : " · optional"}` })),
        el("div", {}, el("div", { textContent: t.purpose, className: "purpose" }), detail),
      );
    }),
  );
}

$("open").addEventListener("click", async () => {
  const r = await api.pick();
  if (!r.ok && !("canceled" in r) && r.dir) errors.set(r.dir, { error: r.error, ...(r.hint ? { hint: r.hint } : {}) });
  void renderProjects();
});
$("recheck").addEventListener("click", () => void renderTools());
$("version").textContent = `ScribUI ${api.version}`;
api.onChange(() => void renderProjects());
window.addEventListener("focus", () => void renderProjects());

void renderProjects();
void renderTools();

export {};
