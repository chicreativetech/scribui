import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Imported } from "@scribui/core";
import { api, type ImportRequest } from "../api";
import { useStore } from "../store";
import { focusTile } from "./Board";

/**
 * Adding a screen by hand in the review view: a screenshot (a still image), HTML
 * (pasted, or an .html file) or a page from any URL, both rendered by ScribUI with
 * their elements. Each joins the open round as a screen of this app or as a
 * reference from elsewhere.
 */

type Draft =
  | { kind: "image"; blob: Blob; preview: string; width: number; height: number; name?: string }
  | { kind: "html"; html: string; name?: string }
  | { kind: "page"; url: string };

type ImportState = {
  open: boolean;
  draft: Draft | null;
  busy: boolean;
  set(p: Partial<ImportState>): void;
};

export const useImport = create<ImportState>((set) => ({
  open: false,
  draft: null,
  busy: false,
  set: (p) => set(p),
}));

export const openImport = () => useImport.getState().set({ open: true });

function setDraft(draft: Draft) {
  const old = useImport.getState().draft;
  if (old?.kind === "image") URL.revokeObjectURL(old.preview);
  useImport.getState().set({ open: true, draft });
}

function closeImport() {
  const s = useImport.getState();
  if (s.draft?.kind === "image") URL.revokeObjectURL(s.draft.preview);
  s.set({ open: false, draft: null, busy: false });
}

/** Screenshots are usually of this app; HTML and pages from elsewhere usually aren't. */
const DEFAULT_ROLE: Record<Draft["kind"], Imported["role"]> = { image: "app", html: "reference", page: "reference" };

const WIDTHS = [
  { label: "Phone", width: 390 },
  { label: "Tablet", width: 834 },
  { label: "Desktop", width: 1440 },
] as const;

const isHtmlFile = (f: File) => f.type === "text/html" || /\.x?html?$/i.test(f.name);
const baseName = (f: File) => f.name.replace(/\.[^.]+$/, "");

/** Take a screenshot or an .html file from a paste, a drop or the file picker; false when there's neither. */
export async function takeFiles(files: FileList | File[] | null | undefined): Promise<boolean> {
  const list = [...(files ?? [])];
  const image = list.find((f) => f.type.startsWith("image/"));
  const page = list.find(isHtmlFile);
  if (!image && !page) return false;
  try {
    if (image) {
      const img = await createImageBitmap(image);
      const { width, height } = img;
      img.close();
      const name = image.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(image.name) ? baseName(image) : undefined;
      setDraft({ kind: "image", blob: image, preview: URL.createObjectURL(image), width, height, name });
    } else if (page) {
      setDraft({ kind: "html", html: await page.text(), name: baseName(page) });
    }
  } catch {
    useStore.getState().toast({ text: "couldn't read that file", tone: "err" });
  }
  return true;
}

/** A single http(s) URL. */
export function asUrl(text: string): string | null {
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  try {
    return new URL(t).toString();
  } catch {
    return null;
  }
}

/** Markup copied as source (a file, devtools' Copy outerHTML) rather than words. */
export const looksLikeHtml = (text: string) => /^\s*</.test(text) && /<\/?[a-z][\w-]*[\s>/]/i.test(text) && /<\/[a-z][\w-]*>|\/>/i.test(text);

/**
 * What a paste brings, in order: files (a screenshot, an .html file), a URL, HTML
 * source pasted as text, then rich HTML (a selection copied from a web page, which
 * the browser copies with its styles). False when there's nothing to add.
 */
export async function takeClipboard(data: DataTransfer | null): Promise<boolean> {
  if (!data) return false;
  if (data.files.length) return takeFiles(data.files);
  const text = data.getData("text/plain");
  const url = asUrl(text);
  if (url) return setDraft({ kind: "page", url }), true;
  if (looksLikeHtml(text)) return setDraft({ kind: "html", html: text }), true;
  const rich = data.getData("text/html");
  if (rich && /<(div|section|header|main|nav|table|img|button|ul|article|form)\b/i.test(rich)) return setDraft({ kind: "html", html: rich }), true;
  return false;
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

/** On the review board: paste (⌘V) or drop a screenshot, HTML or a link anywhere to add it as a screen. */
export function useBoardImports() {
  useEffect(() => {
    const onBoard = () => {
      const st = useStore.getState();
      return st.view === "board" && !st.helpOpen && !st.sendOpen && !st.sentPrompt && !st.lanOpen && !st.editor;
    };
    const paste = (e: ClipboardEvent) => {
      if (useImport.getState().open || !onBoard() || typing(e.target)) return;
      const data = e.clipboardData;
      if (!data || (!data.files.length && !data.getData("text/plain") && !data.getData("text/html"))) return;
      e.preventDefault();
      void takeClipboard(data).then(
        (ok) => ok || useStore.getState().toast({ text: "paste a screenshot, HTML or a link to add it as a screen", tone: "warn" }),
      );
    };
    const over = (e: DragEvent) => {
      if (onBoard() && (e.dataTransfer?.types.includes("Files") || e.dataTransfer?.types.includes("text/uri-list"))) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!onBoard() || !e.dataTransfer) return;
      const link = asUrl(e.dataTransfer.getData("text/uri-list").split("\n")[0] ?? "");
      if (!e.dataTransfer.files.length && !link) return;
      // also keeps the browser from opening the file in place of the review
      e.preventDefault();
      if (useImport.getState().open) return;
      if (!e.dataTransfer.files.length && link) return setDraft({ kind: "page", url: link });
      void takeFiles(e.dataTransfer.files).then(
        (ok) => ok || useStore.getState().toast({ text: "drop a screenshot or an .html file to add it as a screen", tone: "warn" }),
      );
    };
    window.addEventListener("paste", paste);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("paste", paste);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
}

/** Screenshot pixels per CSS pixel: a screenshot from this screen is usually at its pixel ratio. */
function guessScale(width: number): number {
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  return width / dpr >= 320 ? dpr : 1;
}

/** The server takes PNG: other formats are drawn onto a canvas first. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const img = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.drawImage(img, 0, 0);
  img.close();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("could not convert the image"))), "image/png"));
}

async function base64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("could not read the image"));
    r.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

const titleOf = (html: string) => /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || undefined;

const NOTES: Record<Draft["kind"], string> = {
  image: "A still image: it has no elements, so notes on it are areas of the picture.",
  html: "ScribUI renders the HTML with its scripts off. Notes snap to its elements, and the agent gets the HTML file for exact styles.",
  page: "ScribUI opens the page and takes it whole. Notes snap to its elements.",
};

/** Add a screen: a screenshot, HTML or a page, as a screen of this app or a reference. */
export function ImportDialog() {
  const { open, draft, busy } = useImport();
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<Imported["role"]>("app");
  const [width, setWidth] = useState(1440);
  const [baseUrl, setBaseUrl] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const addRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    setError(null);
    if (!draft) return setLink("");
    setTitle(draft.kind === "page" ? "" : (draft.name ?? (draft.kind === "html" ? (titleOf(draft.html) ?? "") : "")));
    setRole(DEFAULT_ROLE[draft.kind]);
    setBaseUrl("");
  }, [draft]);

  useEffect(() => {
    if (!open) return;
    const paste = (e: ClipboardEvent) => {
      // typing a name or a link pastes into the field
      if (typing(e.target)) return;
      e.preventDefault();
      void takeClipboard(e.clipboardData).then((ok) => ok || setError("paste a screenshot, HTML or a link"));
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeImport();
      } else if (e.key === "Enter" && !e.isComposing && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        e.stopPropagation();
        void addRef.current();
      }
    };
    window.addEventListener("paste", paste);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("paste", paste);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  if (!open) return null;

  const openLink = () => {
    const url = asUrl(link) ?? asUrl(`https://${link.trim()}`);
    if (!url || !link.trim()) return setError("that isn't a link");
    setDraft({ kind: "page", url });
  };

  addRef.current = add;
  async function add() {
    const d = useImport.getState().draft;
    if (!d) return openLink();
    if (useImport.getState().busy) return;
    const base = baseUrl.trim() ? (asUrl(baseUrl) ?? asUrl(`https://${baseUrl.trim()}`)) : undefined;
    if (d.kind === "html" && baseUrl.trim() && !base) return setError("the base URL isn't a link");
    useImport.getState().set({ busy: true });
    setError(null);
    try {
      const named = title.trim() ? { title: title.trim() } : {};
      const body: ImportRequest =
        d.kind === "image"
          ? { kind: "image", role, png: await base64(await asPng(d.blob)), scale: guessScale(d.width), ...named }
          : d.kind === "html"
            ? { kind: "html", role, html: d.html, width, ...(base ? { baseUrl: base } : {}), ...named }
            : { kind: "page", role, url: d.url, width, ...named };
      const r = await api.importScreen(body);
      closeImport();
      const st = useStore.getState();
      await st.refreshRounds();
      await st.load(r.round);
      focusTile(r.screenId);
      st.toast({ text: `added "${r.title}" ${role === "reference" ? "as a reference" : "to the review"}`, tone: "ok" });
    } catch (e) {
      setError((e as Error).message);
      useImport.getState().set({ busy: false });
    }
  }

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && closeImport()}>
      <div className="modal screen-import" role="dialog" aria-label="Add a screen">
        <div className="mh">
          <span>add a screen</span>
          <button onClick={closeImport} aria-label="close">
            esc
          </button>
        </div>
        <div className="mb">
          {!draft ? (
            <>
              <div
                className={`drop-zone ${over ? "over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(false);
                  const dropped = asUrl(e.dataTransfer.getData("text/uri-list").split("\n")[0] ?? "");
                  if (!e.dataTransfer.files.length && dropped) return setDraft({ kind: "page", url: dropped });
                  void takeFiles(e.dataTransfer.files).then((ok) => ok || setError("drop a screenshot or an .html file"));
                }}
                onClick={() => input.current?.click()}
              >
                <b>Drop a screenshot or an HTML file here</b>
                <span className="dim">or paste one (⌘V): a screenshot, HTML, or part of a web page you copied</span>
                <span className="faint">You can also paste or drop them anywhere on the board.</span>
              </div>
              <label className="import-field">
                <span>Or open a page from any site</span>
                <span className="import-row">
                  <input value={link} placeholder="https://…" onChange={(e) => setLink(e.target.value)} spellCheck={false} inputMode="url" />
                  <button className="btn" onClick={openLink} disabled={!link.trim()}>
                    Open
                  </button>
                </span>
              </label>
            </>
          ) : (
            <>
              <div className="import-preview">
                {draft.kind === "image" ? (
                  <>
                    <img src={draft.preview} alt="" />
                    <span className="faint">
                      {draft.width}×{draft.height} px
                    </span>
                  </>
                ) : draft.kind === "html" ? (
                  <>
                    {/* sandboxed with nothing allowed: the markup's scripts never run here */}
                    <iframe className="html-preview" sandbox="" srcDoc={draft.html} title="HTML preview" />
                    <span className="faint">HTML · {Math.max(1, Math.round(draft.html.length / 1024))} KB</span>
                  </>
                ) : (
                  <span className="import-url">{draft.url}</span>
                )}
              </div>
              <label className="import-field">
                <span>Name</span>
                <input
                  autoFocus
                  value={title}
                  placeholder={draft.kind === "page" ? "the page's title" : role === "reference" ? "Reference" : "Screenshot"}
                  onChange={(e) => setTitle(e.target.value)}
                  spellCheck={false}
                />
              </label>
              {draft.kind !== "image" && (
                <div className="import-field">
                  <span>Window</span>
                  <div className="width-switch" role="radiogroup" aria-label="Window width">
                    {WIDTHS.map((w) => (
                      <button key={w.width} role="radio" aria-checked={width === w.width} className={width === w.width ? "on" : ""} onClick={() => setWidth(w.width)}>
                        {w.label} <span className="faint">{w.width}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {draft.kind === "html" && (
                <label className="import-field">
                  <span>Base URL (optional): where its stylesheets and images are, for relative links</span>
                  <input value={baseUrl} placeholder="https://example.com/" onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} inputMode="url" />
                </label>
              )}
              <div className="role-switch" role="radiogroup" aria-label="What is it?">
                <button role="radio" aria-checked={role === "app"} className={role === "app" ? "on" : ""} onClick={() => setRole("app")}>
                  <b>Our app</b>
                  <span>A screen of this app. The agent changes it.</span>
                </button>
                <button
                  role="radio"
                  aria-checked={role === "reference"}
                  className={role === "reference" ? "on" : ""}
                  onClick={() => setRole("reference")}
                >
                  <b>Reference</b>
                  <span>From somewhere else. The agent takes the look from it.</span>
                </button>
              </div>
              <p className="dim import-note">{NOTES[draft.kind]} It stays as it is from round to round.</p>
            </>
          )}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,.html,.htm,text/html"
            hidden
            onChange={(e) => void takeFiles(e.target.files).then((ok) => ok || setError("pick a screenshot or an .html file"))}
          />
          {error && <div className="err import-err">✗ {error}</div>}
          <div className="actions">
            <button className="btn" onClick={closeImport}>
              cancel
            </button>
            {draft && (
              <button className="btn primary" disabled={busy} onClick={() => void add()}>
                {busy ? (draft.kind === "image" ? "Adding…" : "Rendering…") : "Add"} <kbd style={{ marginLeft: 6 }}>⏎</kbd>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
