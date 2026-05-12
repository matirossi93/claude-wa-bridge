#!/usr/bin/env node
// Channel plugin for Claude Code that bridges to the local jarvis-wa-bridge HTTP service.
// Receives inbound events via SSE, delivers replies via POST.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BRIDGE_URL = process.env.WA_BRIDGE_URL ?? "http://127.0.0.1:7878";
const RECONNECT_MS = 3000;

import { appendFileSync } from "fs";
const LOG_FILE = process.env.WA_BRIDGE_PLUGIN_LOG ?? "/tmp/wa-bridge-plugin.log";
function logErr(msg) {
  const line = `[${new Date().toISOString()}] wa-bridge plugin: ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

const mcp = new Server(
  { name: "wa-bridge", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "The sender reads on the messaging app (not this session). Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.",
      "",
      "Messages arrive as <channel source=\"wa-bridge\" chat_id=\"...\" message_id=\"...\" user=\"...\" ts=\"...\">. Reply with the reply tool passing chat_id back. The chat_id is the full sender JID (e.g. 5493814181518@s.whatsapp.net).",
      "",
      "Access is managed by the bridge allowlist (JARVIS_WA_ALLOWLIST). This session cannot change it.",
    ].join("\n"),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply message back to the user. Pass chat_id from the inbound event.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Full JID from inbound meta (e.g. 5493814181518@s.whatsapp.net)" },
          text: { type: "string" },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  switch (req.params.name) {
    case "reply": {
      const r = await fetch(`${BRIDGE_URL}/outbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: args.chat_id, text: args.text }),
      });
      const body = await r.text();
      if (!r.ok) throw new Error(`bridge /outbound returned ${r.status}: ${body}`);
      return { content: [{ type: "text", text: `sent (${body})` }] };
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

async function consumeSSE() {
  while (true) {
    try {
      logErr(`connecting SSE to ${BRIDGE_URL}/events`);
      const resp = await fetch(`${BRIDGE_URL}/events`, {
        headers: { Accept: "text/event-stream" },
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`SSE connect failed: ${resp.status}`);
      }
      logErr("SSE connected");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          logErr("SSE stream ended");
          break;
        }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // Parse SSE block (lines `event:` and `data:`)
          const lines = raw.split("\n");
          let evType = "message";
          const dataLines = [];
          for (const ln of lines) {
            if (ln.startsWith("event:")) evType = ln.slice(6).trim();
            else if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trim());
            // `:` comments and others are ignored
          }
          if (evType !== "inbound" || dataLines.length === 0) continue;
          let payload;
          try { payload = JSON.parse(dataLines.join("\n")); }
          catch (e) { logErr(`bad SSE payload: ${e}`); continue; }
          logErr(`emit notification chat_id=${payload.chat_id} text=${JSON.stringify(payload.text).slice(0,120)}`);
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: payload.text,
              meta: {
                chat_id: payload.chat_id,
                message_id: payload.id,
                user: payload.user_id,
                user_id: payload.user_id,
                ts: new Date(payload.ts * 1000).toISOString(),
              },
            },
          }).then(() => logErr("notification sent")).catch(err => logErr(`notify failed: ${err}`));
        }
      }
    } catch (e) {
      logErr(`SSE loop error: ${e}`);
    }
    await new Promise(r => setTimeout(r, RECONNECT_MS));
  }
}

const transport = new StdioServerTransport();
await mcp.connect(transport);
logErr("MCP server started");
consumeSSE().catch(e => logErr(`SSE fatal: ${e}`));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
