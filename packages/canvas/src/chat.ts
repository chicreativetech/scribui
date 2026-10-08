import { create } from "zustand";
import { useStore } from "./store";

/**
 * The AI chat panel: talk to the coding agent the user already has (Claude Code, Codex,
 * Cursor or any command) without leaving ScribUI. Optional all the way: "copy" mode only
 * copies prompts for a terminal, and the panel can stay closed for good.
 */

export type ChatAgentId = "claude" | "codex" | "cursor" | "custom";
/** "copy": no agent connected, prompts are copied for the user's own terminal. */
export type ChatChoice = ChatAgentId | "copy";
export type ChatAgent = { id: ChatAgentId; label: string; available: boolean; hint: string };
export type ChatMessage = { id: string; role: "user" | "agent" | "activity" | "error"; text: string; at: number };
export type ChatServerState = { running: boolean; agent: ChatAgentId | null; messages: ChatMessage[] };

type ChatStore = {
  open: boolean;
  /** null until the user picks: nothing is connected by default. */
  choice: ChatChoice | null;
  /** The shell command for "custom". */
  command: string;
  /** Sending a round to the agent also starts it in the chat. */
  autoRun: boolean;
  draft: string;
  agents: ChatAgent[];
  folder: string;
  server: ChatServerState;
  /** The server can't run agents here (a paired tablet, or an older server). */
  unavailable: string | null;
  set(p: Partial<ChatStore>): void;
  toggle(): void;
  choose(c: ChatChoice | null): void;
  refresh(): Promise<void>;
  send(text?: string): Promise<boolean>;
  stop(): Promise<void>;
  clear(): Promise<void>;
};

const KEY = "scribui:chat";
type Saved = Pick<ChatStore, "open" | "choice" | "command" | "autoRun">;
function loadSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
  } catch {
    return {};
  }
}
function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ open: s.open, choice: s.choice, command: s.command, autoRun: s.autoRun }));
  } catch {
    /* storage blocked */
  }
}

async function post(path: string, body: unknown = {}) {
  const r = await fetch(`/api/chat/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as ChatServerState & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status} ${r.statusText}`);
  return j;
}

const saved = loadSaved();

export const useChat = create<ChatStore>((set, get) => ({
  open: saved.open ?? false,
  choice: saved.choice ?? null,
  command: saved.command ?? "",
  autoRun: saved.autoRun ?? false,
  draft: "",
  agents: [],
  folder: "",
  server: { running: false, agent: null, messages: [] },
  unavailable: null,
  set(p) {
    set(p);
    save(get());
  },
  toggle() {
    get().set({ open: !get().open });
    if (get().open) void get().refresh();
  },
  choose(choice) {
    get().set({ choice });
  },
  async refresh() {
    try {
      const r = await fetch("/api/chat/state");
      const j = (await r.json()) as { state: ChatServerState; agents: ChatAgent[]; folder: string; error?: string };
      if (!r.ok) return set({ unavailable: j.error ?? "the AI chat isn't available here" });
      set({ server: j.state, agents: j.agents, folder: j.folder, unavailable: null });
    } catch {
      set({ unavailable: "the AI chat isn't available here" });
    }
  },
  /** Send the draft (or `text`). In copy mode, copies it instead. Resolves true when it went out. */
  async send(text) {
    const { choice, command, draft } = get();
    const prompt = (text ?? draft).trim();
    if (!prompt) return false;
    if (!choice || choice === "copy") {
      try {
        await navigator.clipboard.writeText(prompt);
        useStore.getState().toast({ text: "prompt copied: paste it into your agent", tone: "ok" });
        if (text === undefined) set({ draft: "" });
        return true;
      } catch {
        useStore.getState().toast({ text: "couldn't copy: the clipboard is blocked", tone: "err" });
        return false;
      }
    }
    try {
      set({ server: await post("send", { agent: choice, text: prompt, ...(choice === "custom" ? { command } : {}) }) });
      if (text === undefined) set({ draft: "" });
      return true;
    } catch (e) {
      useStore.getState().toast({ text: (e as Error).message, tone: "err" });
      return false;
    }
  },
  async stop() {
    try {
      set({ server: await post("stop") });
    } catch (e) {
      useStore.getState().toast({ text: (e as Error).message, tone: "err" });
    }
  },
  async clear() {
    try {
      set({ server: await post("clear") });
    } catch (e) {
      useStore.getState().toast({ text: (e as Error).message, tone: "err" });
    }
  },
}));

/** A connected agent runs prompts; copy mode and "not chosen" don't. */
export const chatConnected = (s: Pick<ChatStore, "choice" | "unavailable"> = useChat.getState()) => !!s.choice && s.choice !== "copy" && !s.unavailable;

export const agentLabel = (id: ChatChoice | null, agents = useChat.getState().agents) =>
  id === "copy" ? "Copy only" : (agents.find((a) => a.id === id)?.label ?? id ?? "");

/**
 * A round was sent: hand its prompt to the chat. With auto-run on, the agent starts right
 * away (true); otherwise the prompt waits in the composer.
 */
export async function handOffToChat(prompt: string): Promise<boolean> {
  const c = useChat.getState();
  if (!chatConnected(c)) return false;
  if (!c.open) c.toggle();
  if (c.autoRun && !c.server.running) return c.send(prompt);
  c.set({ draft: prompt });
  return false;
}
