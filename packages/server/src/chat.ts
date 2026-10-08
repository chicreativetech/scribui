import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The canvas's AI chat: runs a coding agent the user already has (Claude Code, Codex,
 * Cursor or any command) in the project folder, one prompt at a time, and keeps the
 * conversation going with the agent's own session id. Nothing here is required: the
 * user can keep using their terminal and never connect an agent.
 */

export type ChatAgentId = "claude" | "codex" | "cursor" | "custom";

export type ChatAgent = { id: ChatAgentId; label: string; available: boolean; hint: string };

export type ChatMessage = {
  id: string;
  /** activity: what the agent did (a file edited, a command run); error: it failed. */
  role: "user" | "agent" | "activity" | "error";
  text: string;
  at: number;
};

export type ChatState = { running: boolean; agent: ChatAgentId | null; messages: ChatMessage[] };

/** What one line of an agent's JSON output means for the chat. */
export type ChatChunk = { session?: string; text?: string; activity?: string; error?: string };

const AGENTS: { id: Exclude<ChatAgentId, "custom">; label: string; bin: string; install: string }[] = [
  { id: "claude", label: "Claude Code", bin: "claude", install: "npm i -g @anthropic-ai/claude-code" },
  { id: "codex", label: "Codex", bin: "codex", install: "npm i -g @openai/codex" },
  { id: "cursor", label: "Cursor", bin: "cursor-agent", install: "curl https://cursor.com/install -fsS | bash" },
];

const MAX_MESSAGES = 300;

/** Find an executable on PATH, as a shell would. */
export function which(bin: string, path = process.env.PATH ?? ""): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const short = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** One tool call as a short line: "Edit src/App.tsx", "Bash npm test". */
function toolLine(name: string, input: Record<string, unknown> | undefined): string {
  const arg = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.description;
  return typeof arg === "string" ? `${name} ${short(arg)}` : name;
}

/** Claude Code (and Cursor's agent, which speaks the same format): `--output-format stream-json`. */
export function parseClaudeLine(o: Record<string, unknown>): ChatChunk[] {
  const out: ChatChunk[] = [];
  const session = typeof o.session_id === "string" ? o.session_id : typeof o.chatId === "string" ? o.chatId : undefined;
  if (session && (o.type === "system" || o.type === "result")) out.push({ session });
  if (o.type === "assistant") {
    const content = (o.message as { content?: unknown } | undefined)?.content;
    for (const c of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) out.push({ text: c.text });
      else if (c.type === "tool_use" && typeof c.name === "string") out.push({ activity: toolLine(c.name, c.input as Record<string, unknown>) });
    }
  } else if (o.type === "result" && o.is_error) {
    out.push({ error: typeof o.result === "string" && o.result ? o.result : String(o.subtype ?? "the agent failed") });
  }
  return out;
}

/** Codex: `codex exec --json`. */
export function parseCodexLine(o: Record<string, unknown>): ChatChunk[] {
  const item = (o.item ?? {}) as Record<string, unknown>;
  if (o.type === "thread.started" && typeof o.thread_id === "string") return [{ session: o.thread_id }];
  if (o.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") return [{ text: item.text }];
  if (o.type === "item.started" && item.type === "command_execution" && typeof item.command === "string") return [{ activity: `$ ${short(item.command)}` }];
  if (o.type === "item.completed" && item.type === "file_change" && Array.isArray(item.changes)) {
    const paths = (item.changes as { path?: string }[]).map((c) => c.path).filter(Boolean);
    return [{ activity: `edited ${paths.join(", ")}` }];
  }
  if (o.type === "error" && typeof o.message === "string") return [{ error: o.message }];
  if (o.type === "turn.failed") return [{ error: String((o.error as { message?: string } | undefined)?.message ?? "the turn failed") }];
  return [];
}

/** The command line for one prompt. The prompt goes in on stdin unless `promptArg` is set. */
export function agentCommand(agent: ChatAgentId, session: string | undefined, custom?: string): { cmd: string; args: string[]; shell?: boolean; promptArg?: boolean; json: boolean } {
  switch (agent) {
    case "claude":
      // acceptEdits: the agent may edit files in the project, but asks for nothing else it can't do headless
      return { cmd: "claude", args: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", ...(session ? ["--resume", session] : [])], json: true };
    case "codex":
      return { cmd: "codex", args: ["exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", ...(session ? ["resume", session] : []), "-"], json: true };
    case "cursor":
      return { cmd: "cursor-agent", args: ["-p", "--output-format", "stream-json", ...(session ? ["--resume", session] : [])], promptArg: true, json: true };
    case "custom":
      if (!custom?.trim()) throw new Error("set the command to run first");
      return { cmd: custom, args: [], shell: true, json: false };
  }
}

export class ChatSession {
  private messages: ChatMessage[] = [];
  private agent: ChatAgentId | null = null;
  private child: ChildProcess | null = null;
  private sessions = new Map<ChatAgentId, string>();
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cwd: string,
    private readonly onChange: (s: ChatState) => void,
  ) {}

  state(): ChatState {
    return { running: !!this.child, agent: this.agent, messages: this.messages };
  }

  agents(): ChatAgent[] {
    return [
      ...AGENTS.map((a) => {
        const found = !!which(a.bin);
        return { id: a.id, label: a.label, available: found, hint: found ? `runs ${a.bin}` : `not installed: ${a.install}` };
      }),
      { id: "custom" as const, label: "Other command", available: true, hint: "any command that reads a prompt on stdin" },
    ];
  }

  send(agent: ChatAgentId, text: string, custom?: string) {
    if (this.child) throw new Error("the agent is still working; stop it first");
    if (!text.trim()) throw new Error("empty prompt");
    const { cmd, args, shell, promptArg, json } = agentCommand(agent, this.sessions.get(agent), custom);
    if (!shell && !which(cmd)) throw new Error(`\`${cmd}\` was not found on PATH`);
    this.agent = agent;
    this.push("user", text);

    const child = spawn(cmd, promptArg ? [...args, text] : args, {
      cwd: this.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: !!shell,
      // its own process group, so stop() also ends whatever the agent started
      detached: process.platform !== "win32",
      stdio: [promptArg ? "ignore" : "pipe", "pipe", "pipe"],
    });
    this.child = child;
    if (!promptArg) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(text);
    }

    let errored = false;
    let stderr = "";
    let buf = "";
    let plain: ChatMessage | null = null;
    const onLine = (line: string) => {
      if (!json) {
        // a plain command: its output is the answer, as it comes
        if (!plain) plain = this.push("agent", "");
        plain.text += line + "\n";
        return this.changed();
      }
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const chunks = agent === "codex" ? parseCodexLine(o) : parseClaudeLine(o);
      for (const c of chunks) {
        if (c.session) this.sessions.set(agent, c.session);
        if (c.text) this.push("agent", c.text);
        if (c.activity) this.push("activity", c.activity);
        if (c.error) {
          errored = true;
          this.push("error", c.error);
        }
      }
    };
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-2000);
    });
    const finish = (code: number | null, err?: Error) => {
      if (this.child !== child) return;
      if (buf.trim()) onLine(buf);
      this.child = null;
      if (err) this.push("error", err.message);
      else if (code !== 0 && code !== null && !errored) this.push("error", short(stderr.trim(), 600) || `${cmd} exited with code ${code}`);
      else if (code === null) this.push("activity", "stopped");
      this.changed(true);
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
    this.changed(true);
  }

  stop() {
    const c = this.child;
    if (!c?.pid) return;
    try {
      if (process.platform === "win32") c.kill();
      else process.kill(-c.pid, "SIGTERM");
    } catch {
      c.kill();
    }
  }

  /** Start a new conversation: the next prompt opens a fresh agent session. */
  clear() {
    this.stop();
    this.messages = [];
    this.sessions.clear();
    this.changed(true);
  }

  private push(role: ChatMessage["role"], text: string): ChatMessage {
    const m: ChatMessage = { id: `m${++this.seq}`, role, text, at: Date.now() };
    this.messages.push(m);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.changed();
    return m;
  }

  /** Coalesce bursts of output into a few updates a second. */
  private changed(now = false) {
    if (now) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return this.onChange(this.state());
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.onChange(this.state());
    }, 120);
  }
}
