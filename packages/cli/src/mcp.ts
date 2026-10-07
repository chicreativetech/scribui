import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { PRODUCT } from "@scribui/core";
import type { ReviewStore } from "@scribui/server";
import { captureProject } from "@scribui/project";

/**
 * Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited).
 * Tools: request_review, get_feedback (non-blocking), list_rounds.
 */
export async function runMcp(store: ReviewStore) {
  const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");
  const tools = [
    {
      name: "request_review",
      description:
        "Capture every screen in .scribui/screens.json into a new review round. Afterwards tell the user the round is ready and that they can open it with `npx scribui open`.",
      inputSchema: {
        type: "object",
        properties: {
          screens: { type: "array", items: { type: "string" }, description: "Capture exactly these; reuse the rest" },
          all: { type: "boolean", description: "Recapture every screen" },
        },
      },
    },
    {
      name: "get_feedback",
      description:
        "Non-blocking. Returns {state: 'waiting'} while the human is still reviewing, or {state: 'done', review} with the compiled review.md once they pressed Send. After implementing it, call again with mark_applied: true.",
      inputSchema: {
        type: "object",
        properties: {
          mark_applied: { type: "boolean", description: "Mark the latest sent round as applied" },
          changed_screens: {
            description:
              'With mark_applied: ids of screens whose UI you changed, or "all" for shared styles/components. Only these are recaptured next time.',
            oneOf: [{ type: "array", items: { type: "string" } }, { type: "string", enum: ["all"] }],
          },
        },
      },
    },
    { name: "list_rounds", description: "List review rounds and their state.", inputSchema: { type: "object", properties: {} } },
  ];

  const call = async (name: string, args: Record<string, unknown>) => {
    if (name === "list_rounds") {
      const rounds = [];
      for (const n of await store.listRounds()) {
        const s = await store.readStatus(n).catch(() => null);
        rounds.push({ round: n, status: s?.status ?? "unknown" });
      }
      return { rounds };
    }
    if (name === "request_review") {
      // handed to the project's server when one runs (the canvas or desktop app), otherwise run here
      const got = await captureProject(store, { app: "mcp", screens: args["screens"] as string[] | undefined, all: args["all"] === true });
      const next = "Ask the user to review with `npx scribui open`.";
      if (got.via === "server") {
        const r = got.result;
        if (r.skipped) return { round: null, captured: [], note: r.summary };
        return { round: r.round, captured: r.ok ?? [], reused: r.reused ?? [], failed: r.failed, next };
      }
      const res = got.result;
      if (!res) return { error: "capture tools not ready; run `npx scribui doctor`" };
      if (res.skipped) return { round: res.round, captured: [], note: `nothing to capture: ${res.plan.why}` };
      return { round: res.round, captured: res.ok, reused: res.reused, failed: res.failed, next };
    }
    if (name === "get_feedback") {
      const n = await store.latestRound();
      if (n === null) return { state: "none", hint: "call request_review first" };
      const s = await store.readStatus(n);
      if (args["mark_applied"] && s.status === "sent") {
        const changed = args["changed_screens"];
        await store.setStatus(n, "applied", {
          ...(changed === "all" || Array.isArray(changed) ? { changedScreens: changed as string[] | "all" } : {}),
        });
        return { state: "applied", round: n };
      }
      if (s.status !== "sent") return { state: s.status === "applied" ? "applied" : "waiting", round: n };
      const review = await readFile(store.path("rounds", String(n).padStart(3, "0"), "review.md"), "utf8");
      return { state: "done", round: n, folder: `${PRODUCT.folder}/latest`, review };
    }
    throw new Error(`unknown tool ${name}`);
  };

  const rl = createInterface({ input: process.stdin });
  for await (const lineText of rl) {
    if (!lineText.trim()) continue;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(lineText);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (params?.["protocolVersion"] as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "scribui", version: "0.1.0" },
        },
      });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
    } else if (method === "tools/call") {
      try {
        const r = await call(String(params?.["name"]), (params?.["arguments"] as Record<string, unknown>) ?? {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String((e as Error).message) }] } });
      }
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
}
