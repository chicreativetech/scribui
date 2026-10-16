import { capturable, defaultRole, findProjects, pageInfo } from "./lib.js";

/** @typedef {import("./lib.js").Project} Project */

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const el of document.querySelectorAll("main")) el.hidden = el.id !== id;
};

const pad = (n) => String(n).padStart(3, "0");

/** The tab to send: the one the popup was opened on (`?tab=` when the popup is opened as a page). */
async function targetTab() {
  const id = Number(new URLSearchParams(location.search).get("tab"));
  if (id) return chrome.tabs.get(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function main() {
  const tab = await targetTab();
  if (!tab?.id || !capturable(tab.url)) return show("blocked");

  const saved = await chrome.storage.local.get({ ports: [], lastRoot: "", scroll: true });
  const projects = await findProjects(saved.ports);
  if (!projects.length) return show("none");

  const info = await chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: pageInfo })
    .then((r) => r[0]?.result)
    .catch(() => null);

  const select = $("project");
  select.replaceChildren(
    ...projects.map((p, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = projects.length > 1 ? `${p.name}  ·  ${p.root}` : p.name;
      return o;
    }),
  );
  const last = projects.findIndex((p) => p.root === saved.lastRoot);
  select.value = String(Math.max(0, last));
  $("project-field").title = projects[Number(select.value)].root;

  $("title").value = info?.title || tab.title || "";
  $("scroll").checked = saved.scroll;

  /** @type {"app" | "reference"} */
  let role = defaultRole(tab.url, projects[Number(select.value)]);
  let rolePicked = false;
  const paintRole = () => {
    for (const b of document.querySelectorAll(".roles button")) b.setAttribute("aria-checked", String(b.dataset.role === role));
  };
  for (const b of document.querySelectorAll(".roles button")) {
    b.addEventListener("click", () => {
      role = /** @type {"app" | "reference"} */ (b.dataset.role);
      rolePicked = true;
      paintRole();
    });
  }
  const project = () => projects[Number(select.value)];
  const check = () => {
    const p = project();
    const warn = $("warn");
    warn.hidden = p.canRenderPages;
    warn.textContent = p.canRenderPages ? "" : "This project's ScribUI can't render pages: it needs Playwright, like web capture (npx playwright install chromium).";
    $("send").disabled = !p.canRenderPages;
    $("project-field").title = p.root;
  };
  select.addEventListener("change", () => {
    if (!rolePicked) role = defaultRole(tab.url, project());
    paintRole();
    check();
  });
  paintRole();
  check();
  show("form");
  $("title").select();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "progress") $("status").textContent = msg.step;
  });

  const send = async () => {
    const p = project();
    $("send").disabled = true;
    $("status").textContent = "Starting…";
    void chrome.storage.local.set({ lastRoot: p.root, scroll: $("scroll").checked });
    const res = await chrome.runtime.sendMessage({
      type: "send",
      tabId: tab.id,
      server: p.url,
      role,
      title: $("title").value,
      width: info?.width ?? 1440,
      scroll: $("scroll").checked,
    });
    if (!res?.ok) {
      $("send").disabled = false;
      $("status").textContent = "";
      $("warn").hidden = false;
      $("warn").textContent = res?.error ?? "Something went wrong.";
      return;
    }
    $("done-title").textContent = `"${res.result.title}" is in Review`;
    $("done-where").textContent = `${role === "reference" ? "As a reference" : "As a screen of the app"} · ${p.name} · round ${pad(res.result.round)}`;
    $("open").onclick = () => void chrome.tabs.create({ url: p.url });
    show("done");
  };
  $("send").addEventListener("click", () => void send());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("form").hidden && !$("send").disabled && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      void send();
    }
  });
}

$("retry").addEventListener("click", () => {
  show("loading");
  void main();
});
$("port-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const port = Number($("port").value);
  if (!port) return;
  const { ports } = await chrome.storage.local.get({ ports: [] });
  await chrome.storage.local.set({ ports: [...new Set([...ports, port])] });
  show("loading");
  void main();
});

void main().catch((e) => {
  show("none");
  $("none").querySelector("p").textContent = `Something went wrong: ${e.message}`;
});
