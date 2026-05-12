# claude-wa-bridge

Claude Code channel plugin that bridges to a local `jarvis-wa-bridge` HTTP service.

The plugin connects to `${WA_BRIDGE_URL:-http://127.0.0.1:7878}/events` via SSE for inbound, and posts replies to `/outbound`. The HTTP bridge is responsible for talking to the actual WhatsApp gateway (an OpenClaw Clarita container in this setup).

## Install (Claude Code)

```bash
claude plugin marketplace add matirossi93/claude-wa-bridge
claude plugin install wa-bridge@matirossi-channels
```

Then in your tmux session:

```bash
claude --dangerously-skip-permissions --channels plugin:wa-bridge@matirossi-channels
```
