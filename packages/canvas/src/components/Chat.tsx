import { useEffect, useRef } from "react";
import { agentLabel, chatConnected, useChat, type ChatChoice } from "../chat";
import { Spinner } from "./Capture";

/* ───────── the Chat box in the top bar: shows and hides the panel ───────── */

export function ChatToggle() {
  const open = useChat((s) => s.open);
  const running = useChat((s) => s.server.running);
  return (
    <div className="float chat-toggle">
      <button
        className={`item ${open ? "on" : ""}`}
        onClick={() => useChat.getState().toggle()}
        aria-pressed={open}
        title="AI chat: prompt your coding agent without leaving ScribUI"
      >
        {running && !open && <Spinner />}
        Chat
      </button>
    </div>
  );
}

/* ───────── the panel ───────── */

export function ChatPanel() {
  const open = useChat((s) => s.open);
  const choice = useChat((s) => s.choice);
  const unavailable = useChat((s) => s.unavailable);
  const hasMessages = useChat((s) => s.server.messages.length > 0);
  const running = useChat((s) => s.server.running);

  useEffect(() => {
    if (open) void useChat.getState().refresh();
  }, [open]);

  if (!open) return null;
  return (
    <aside className="float chat" aria-label="AI chat">
      <div className="chat-head">
        <h3>AI chat</h3>
        {choice && !unavailable && <AgentSelect />}
        {hasMessages && (
          <button className="btn" onClick={() => void useChat.getState().clear()} disabled={running} title="start a new conversation">
            New
          </button>
        )}
      </div>
      {unavailable ? (
        <div className="chat-empty">{unavailable}.</div>
      ) : !choice ? (
        <Connect />
      ) : (
        <>
          {choice === "custom" && <CommandField />}
          <Log />
          <Composer />
        </>
      )}
    </aside>
  );
}

function AgentSelect() {
  const choice = useChat((s) => s.choice);
  const agents = useChat((s) => s.agents);
  const running = useChat((s) => s.server.running);
  return (
    <select
      className="chat-agent"
      value={choice ?? ""}
      disabled={running}
      onChange={(e) => useChat.getState().choose((e.target.value || null) as ChatChoice | null)}
      title="which agent the chat talks to"
    >
      {agents
        .filter((a) => a.available || a.id === choice)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      <option value="copy">Copy only</option>
      <option value="">Disconnect…</option>
    </select>
  );
}

/** First open: pick an agent, or none. */
function Connect() {
  const agents = useChat((s) => s.agents);
  const choose = (c: ChatChoice) => useChat.getState().choose(c);
  return (
    <div className="chat-connect">
      <p>
        Connect the coding agent you already use, and prompt it from here. It's optional: your terminal works just as well.
      </p>
      <div className="chat-choices">
        {agents.map((a) => (
          <button key={a.id} className="chat-choice" onClick={() => choose(a.id)} disabled={!a.available}>
            <b>{a.label}</b>
            <span>{a.hint}</span>
          </button>
        ))}
        <button className="chat-choice" onClick={() => choose("copy")}>
          <b>Just copy prompts</b>
          <span>no agent here: prompts go to the clipboard for your terminal</span>
        </button>
      </div>
    </div>
  );
}

function CommandField() {
  const command = useChat((s) => s.command);
  return (
    <label className="chat-command">
      <span>command</span>
      <input
        value={command}
        onChange={(e) => useChat.getState().set({ command: e.target.value })}
        placeholder="e.g. aider --yes --message-file -"
        spellCheck={false}
      />
    </label>
  );
}

function Log() {
  const messages = useChat((s) => s.server.messages);
  const running = useChat((s) => s.server.running);
  const choice = useChat((s) => s.choice);
  const folder = useChat((s) => s.folder);
  const ref = useRef<HTMLDivElement>(null);

  // follow new output, unless the user scrolled up to read
  const last = messages[messages.length - 1];
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text, running]);

  return (
    <div className="chat-log" ref={ref}>
      {messages.length === 0 && (
        <div className="chat-empty">
          {choice === "copy" ? (
            <>Write a prompt and press <b>Copy</b>, then paste it into your agent.</>
          ) : (
            <>
              Ask <b>{agentLabel(choice)}</b> anything about this project. It runs in <code>{folder.split(/[\\/]/).pop()}</code> and
              can edit its files.
              <br />
              <br />
              <b>Send to agent</b> puts the round's prompt here.
            </>
          )}
        </div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`chat-msg ${m.role}`}>
          {m.text}
        </div>
      ))}
      {running && (
        <div className="chat-msg activity">
          <Spinner /> working…
        </div>
      )}
    </div>
  );
}

function Composer() {
  const draft = useChat((s) => s.draft);
  const running = useChat((s) => s.server.running);
  const autoRun = useChat((s) => s.autoRun);
  const connected = useChat((s) => chatConnected(s));
  const ta = useRef<HTMLTextAreaElement>(null);

  // a sent round's prompt landed here: ready to edit or send
  useEffect(() => {
    if (draft) ta.current?.focus();
  }, [draft]);

  const send = () => void useChat.getState().send();
  return (
    <div className="chat-compose">
      <textarea
        ref={ta}
        value={draft}
        rows={3}
        onChange={(e) => useChat.getState().set({ draft: e.target.value })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!running) send();
          }
        }}
        placeholder={connected ? "Prompt your agent…" : "Write a prompt…"}
        spellCheck
      />
      <div className="chat-foot">
        {connected ? (
          <label className="chat-auto" title="Send to agent also starts the agent here, without a paste">
            <input type="checkbox" checked={autoRun} onChange={(e) => useChat.getState().set({ autoRun: e.target.checked })} />
            Run sent rounds
          </label>
        ) : (
          <span className="faint">⏎ copy · ⇧⏎ new line</span>
        )}
        {running ? (
          <button className="send-btn stop" onClick={() => void useChat.getState().stop()}>
            Stop
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!draft.trim()}>
            {connected ? "Send" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}
