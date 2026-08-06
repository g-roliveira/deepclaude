# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

deepclaude is a CLI tool that lets Claude Code run with cheaper model backends (DeepSeek V4 Pro, OpenRouter, Fireworks AI) instead of Anthropic. It works by overriding `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` so Claude Code's API calls go to a different provider.

Two modes:
1. **Direct mode** — sets env vars and launches `claude` directly. Model calls go straight to the backend's Anthropic-compatible endpoint.
2. **Remote/proxy mode** — starts a local Node.js HTTP proxy, then launches `claude remote-control`. The proxy routes `/v1/messages` to the cheap backend and everything else to Anthropic (needed because remote control's WebSocket bridge is hardcoded to Anthropic).

## Architecture

```
deepclaude.sh / deepclaude.ps1     (user-facing CLI entry points)
  └── proxy/start-proxy.js         (CLI for the Node.js proxy)
       └── proxy/model-proxy.js    (HTTP proxy server, core logic)
```

### Shell scripts (`deepclaude.sh`, `deepclaude.ps1`)

Entry points. Parse `--backend`, `--remote`, `--switch`, `--status`, `--cost`, `--benchmark` flags. Resolve backend config (URL, API key, model names) from env vars (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`). Set `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, model env vars, then `exec claude`.

For remote mode: start the Node proxy as a background process, point `ANTHROPIC_BASE_URL` at it, unset `ANTHROPIC_AUTH_TOKEN` (OAuth handles bridge auth), launch `claude remote-control`. Proxy is killed on script exit via `trap cleanup_proxy EXIT`.

### `proxy/model-proxy.js` (core)

HTTP server on `127.0.0.1:3200` (auto-increments port if busy). Exports `startModelProxy({targetUrl, apiKey, startPort, backends, defaultMode})`.

**Request routing:**
- `/_proxy/status` GET — returns `{mode, uptime, requests}`
- `/_proxy/cost` GET — returns per-backend token counts, cost, savings vs Anthropic pricing
- `/_proxy/mode` POST — switches active backend. Body: `backend=deepseek|openrouter|fireworks|anthropic`. Origin-restricted to localhost.
- `/v1/messages` — if mode is non-Anthropic, routes to the selected backend with its API key. If Anthropic mode, passes through to `api.anthropic.com`.
- Everything else — passes through to `api.anthropic.com` unchanged.

**Model name remapping** — `MODEL_REMAP` maps Claude model names to backend-specific names (e.g., `claude-opus-4-6` → `deepseek-v4-pro` for DeepSeek, `deepseek/deepseek-v4-pro` for OpenRouter).

**SSE normalization** — `UsageNormalizer` Transform stream. DeepSeek/OpenRouter may omit `usage` in `message_start`/`message_delta` SSE events, which crashes Claude Code. The normalizer injects zeroed usage fields when missing.

**Thinking block stripping** — non-Anthropic backends reject thinking blocks they didn't generate. For model calls to non-Anthropic backends, all thinking blocks are stripped from the request body before forwarding. For Anthropic mode after a non-Anthropic session, all thinking blocks are also stripped (since foreign backends produce signed-but-invalid blocks that Anthropic rejects).

**Cost tracking** — tracks input/output tokens per backend. `/_proxy/cost` returns actual cost vs Anthropic equivalent using hardcoded pricing per million tokens.

### `proxy/start-proxy.js`

CLI wrapper around `startModelProxy`. Two modes:
- **Legacy** (`start-proxy.js <targetUrl> <apiKey>`) — single backend, prints port to stdout. Used by shell scripts for remote mode.
- **Standalone** (`start-proxy.js --mode <name> --port <N>`) — multi-backend with live toggle. Reads keys from env vars.

## No tests, no build step

This project has no test suite and no build/compile step. The shell scripts are bash/PowerShell. The proxy is plain Node.js (ESM) with zero dependencies — no `package.json`, no `node_modules`. To run it: `node proxy/start-proxy.js` or `./deepclaude.sh`.

## Common patterns when editing

- **Shell scripts** — bash and PowerShell versions must stay in sync. Any change to one likely needs a matching change in the other.
- **Proxy** — `state` object holds current mode, target URL, API key. `switchMode()` mutates it. Server reads `state` on every request (no locking needed; single-threaded).
- **MODEL_REMAP** — when adding a new backend, add entries here and in both shell scripts' `resolve_backend()`.
- **Control endpoints** — all under `/_proxy/` prefix. Never collides with `/v1/` API paths.
- **Backend URLs** — DeepSeek uses `x-api-key` header. OpenRouter and Fireworks use `Authorization: Bearer`. The `useBearer` flag in backend config controls this.
