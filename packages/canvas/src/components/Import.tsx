import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Imported } from "@scribui/core";
import { api, type ImportRequest } from "../api";
import { useStore } from "../store";
import { focusTile } from "./Board";

/**
 * Adding a screen by hand in the review view: a pasted, dropped or chosen screenshot.
 * It joins the open round as a still image, either as a screen of this app or as a
 * reference from elsewhere.
 */

type Draft = { kind: "image"; blob: Blob; preview: string; width: number; height: number; name?: string };

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

function closeImport() {
  const s = useImport.getState();
  if (s.draft) URL.revokeObjectURL(s.draft.preview);
  s.set({ open: false, draft: null, busy: false });
}

const DEFAULT_ROLE: Record<Draft["kind"], Imported["role"]> = { image: "app" };

/** Take a screenshot from a paste, a drop or the file picker; false when none of the files is an image. */
export async function takeFiles(files: FileList | File[] | null | undefined): Promise<boolean> {
  const file = [...(files ?? [])].find((f) => f.type.startsWith("image/"));
  if (!file) return false;
  try {
    const img = await createImageBitmap(file);
    const { width, height } = img;
    img.close();
    const old = useImport.getState().draft;
    if (old) URL.revokeObjectURL(old.preview);
    const name = file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? file.name.replace(/\.[^.]+$/, "") : undefined;
    useImport.getState().set({ open: true, draft: { kind: "image", blob: file, preview: URL.createObjectURL(file), width, height, name } });
  } catch {
    useStore.getState().toast({ text: "couldn't read that image", tone: "err" });
  }
  return true;
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

/** On the review board: paste (⌘V) or drop a screenshot anywhere to add it as a screen. */
export function useBoardImports() {
  useEffect(() => {
    const onBoard = () => {
      const st = useStore.getState();
      return st.view === "board" && !st.helpOpen && !st.sendOpen && !st.sentPrompt && !st.lanOpen && !st.editor;
    };
    const paste = (e: ClipboardEvent) => {
      if (useImport.getState().open || !onBoard() || typing(e.target)) return;
      const files = e.clipboardData?.files;
      if (!files?.length) return;
      e.preventDefault();
      void takeFiles(files).then((ok) => ok || useStore.getState().toast({ text: "only images can be pasted here", tone: "warn" }));
    };
    const over = (e: DragEvent) => {
      if (onBoard() && e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!onBoard() || !e.dataTransfer?.files.length) return;
      // also keeps the browser from opening the file in place of the review
      e.preventDefault();
      if (useImport.getState().open) return;
      void takeFiles(e.dataTransfer.files).then((ok) => ok || useStore.getState().toast({ text: "only images can be added here", tone: "warn" }));
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
async function asPng(d: Draft): Promise<Blob> {
  if (d.blob.type === "image/png") return d.blob;
  const img = await createImageBitmap(d.blob);
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

/** Add a screen: a screenshot as a still image, as a screen of this app or a reference. */
export function ImportDialog() {
  const { open, draft, busy } = useImport();
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<Imported["role"]>("app");
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const addRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    setError(null);
    if (!draft) return;
    setTitle(draft.name ?? "");
    setRole(DEFAULT_ROLE[draft.kind]);
  }, [draft]);

  useEffect(() => {
    if (!open) return;
    const paste = (e: ClipboardEvent) => {
      if (!e.clipboardData?.files.length) return;
      e.preventDefault();
      void takeFiles(e.clipboardData.files).then((ok) => ok || setError("that isn't an image"));
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeImport();
      } else if (e.key === "Enter" && !e.isComposing) {
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

  addRef.current = add;
  async function add() {
    const d = useImport.getState().draft;
    if (!d || useImport.getState().busy) return;
    useImport.getState().set({ busy: true });
    setError(null);
    try {
      const body: ImportRequest = { kind: "image", role, png: await base64(await asPng(d)), scale: guessScale(d.width), ...(title.trim() ? { title: title.trim() } : {}) };
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
                void takeFiles(e.dataTransfer.files).then((ok) => ok || setError("that isn't an image"));
              }}
              onClick={() => input.current?.click()}
            >
              <b>Drop a screenshot here</b>
              <span className="dim">or paste it (⌘V), or click to choose a file</span>
              <span className="faint">PNG, JPEG, GIF or WebP. You can also paste or drop one anywhere on the board.</span>
            </div>
          ) : (
            <>
              <div className="import-preview">
                <img src={draft.preview} alt="" />
                <span className="faint">
                  {draft.width}×{draft.height} px
                </span>
              </div>
              <label className="import-field">
                <span>Name</span>
                <input
                  autoFocus
                  value={title}
                  placeholder={role === "reference" ? "Reference" : "Screenshot"}
                  onChange={(e) => setTitle(e.target.value)}
                  spellCheck={false}
                />
              </label>
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
              <p className="dim import-note">
                A still image: it has no elements, so notes on it are areas of the picture. It stays as it is from round to round.
              </p>
            </>
          )}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => void takeFiles(e.target.files).then((ok) => ok || setError("that isn't an image"))}
          />
          {error && <div className="err">✗ {error}</div>}
          <div className="actions">
            <button className="btn" onClick={closeImport}>
              cancel
            </button>
            <button className="btn primary" disabled={!draft || busy} onClick={() => void add()}>
              {busy ? "Adding…" : "Add"} <kbd style={{ marginLeft: 6 }}>⏎</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
