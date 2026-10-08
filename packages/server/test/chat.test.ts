import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentCommand, ChatSession, createApp, parseClaudeLine, parseCodexLine, type ChatState } from "../src/index.js";

describe("chat output", () => {
  it("reads Claude Code's stream-json", () => {
    expect(parseClaudeLine({ type: "system", subtype: "init", session_id: "s1" })).toEqual([{ session: "s1" }]);
    expect(
      parseClaudeLine({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Done." }, { type: "tool_use", name: "Edit", input: { file_path: "src/App.tsx" } }] },
      }),
    ).toEqual([{ text: "Done." }, { activity: "Edit src/App.tsx" }]);
    expect(parseClaudeLine({ type: "result", is_error: true, result: "not logged in", session_id: "s1" })).toEqual([{ session: "s1" }, { error: "not logged in" }]);
  });

  it("reads Codex's --json events", () => {
    expect(parseCodexLine({ type: "thread.started", thread_id: "t1" })).toEqual([{ session: "t1" }]);
    expect(parseCodexLine({ type: "item.completed", item: { type: "agent_message", text: "Hi" } })).toEqual([{ text: "Hi" }]);
    expect(parseCodexLine({ type: "item.started", item: { type: "command_execution", command: "npm test" } })).toEqual([{ activity: "$ npm test" }]);
    expect(parseCodexLine({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts" }, { path: "b.ts" }] } })).toEqual([{ activity: "edited a.ts, b.ts" }]);
    expect(parseCodexLine({ type: "turn.failed", error: { message: "boom" } })).toEqual([{ error: "boom" }]);
  });

  it("resumes the agent's own session", () => {
    expect(agentCommand("claude", "s1").args.slice(-2)).toEqual(["--resume", "s1"]);
    expect(agentCommand("codex", "t1").args.slice(-3)).toEqual(["resume", "t1", "-"]);
    expect(() => agentCommand("custom", undefined, " ")).toThrow();
  });
});

describe("chat session", () => {
  it("runs a custom command with the prompt on stdin and streams its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribui-chat-"));
    const script = join(dir, "echo-agent.sh");
    writeFileSync(script, '#!/bin/sh\nprintf "got: "; cat\n');
    chmodSync(script, 0o755);
    let last: ChatState | null = null;
    const done = new Promise<void>((res) => {
      const chat = new ChatSession(dir, (s) => {
        last = s;
        if (!s.running && s.messages.length > 1) res();
      });
      chat.send("custom", "make it orange", script);
    });
    await done;
    const msgs = (last as ChatState | null)!.messages;
    expect(msgs[0]).toMatchObject({ role: "user", text: "make it orange" });
    expect(msgs[1]).toMatchObject({ role: "agent", text: "got: make it orange\n" });
  });
});

describe("chat routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "scribui-chat-app-"));
  const { app } = createApp({ projectDir: dir });
  const env = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
  const req = (path: string, init: RequestInit & { host?: string } = {}) =>
    app.request(path, { ...init, headers: { host: init.host ?? "127.0.0.1:4382", ...(init.headers as Record<string, string>) } }, env);

  it("lists the agents", async () => {
    const r = await req("/api/chat/state");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { agents: { id: string }[] };
    expect(j.agents.map((a) => a.id)).toEqual(["claude", "codex", "cursor", "custom"]);
  });

  it("refuses other sites and non-JSON posts", async () => {
    const body = JSON.stringify({ agent: "custom", text: "hi", command: "true" });
    expect((await req("/api/chat/send", { method: "POST", body, headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await req("/api/chat/send", { method: "POST", body, headers: { "content-type": "application/json", origin: "https://evil.example" } })).status).toBe(403);
    expect((await req("/api/chat/state", { host: "evil.example:4382" })).status).toBe(403);
  });
});
