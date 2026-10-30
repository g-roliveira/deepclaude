# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

deepclaude is a CLI tool that lets Claude Code run with cheaper model backends (DeepSeek V4 Pro, MiniMax M3 Free via OpenRouter, OpenRouter, Fireworks AI) instead of Anthropic. It starts a local proxy and overrides `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` for the launched Claude Code process.

Two launch modes use the same proxy:
1. **Normal mode** — launches `claude` in the terminal.
2. **Remote mode** — launches `claude remote-control`; non-model bridge traffic still passes through to Anthropic.

## Architecture

```
deepclaude.sh                     (Bash CLI entry point)
  └── proxy/start-proxy.js         (CLI for the Node.js proxy)
       └── proxy/model-proxy.js    (HTTP proxy server, core logic)
```

### Bash launcher (`deepclaude.sh`)

Entry points. Parse `--backend`, `--model`, `--remote`, `--switch`, `--status`, `--cost`, `--benchmark` flags. Resolve backend config (URL, API key, model names) from env vars (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`). The `op` backend accepts an arbitrary OpenRouter model ID through `--model`; the proxy applies it per request while preserving Claude Code's recognized internal model label. Set `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, model env vars, then `exec claude`.

For remote mode: start the Node proxy as a background process, point `ANTHROPIC_BASE_URL` at it, unset `ANTHROPIC_AUTH_TOKEN` (OAuth handles bridge auth), launch `claude remote-control`. Proxy is killed on script exit via `trap cleanup_proxy EXIT`.

### `proxy/model-proxy.js` (core)

HTTP server on `127.0.0.1:3200` (auto-increments port if busy). Exports `startModelProxy({targetUrl, apiKey, startPort, backends, defaultMode, modelOverride})`. A model override is request-local routing state for the OpenRouter backend; it does not mutate the global backend when other modes are switched.

**Request routing:**
- `/_proxy/status` GET — returns `{mode, uptime, requests}`
- `/_proxy/cost` GET — returns per-backend token counts, cost, savings vs Anthropic pricing
- `/_proxy/mode` POST — switches active backend. Body: `backend=deepseek|minimax|openrouter|fireworks|anthropic`. Origin-restricted to localhost.
- `/v1/messages` — if mode is non-Anthropic, routes to the selected backend with its API key. If Anthropic mode, passes through to `api.anthropic.com`.
- `/v1/files` and `/v1/files/{id}` — in direct DeepSeek mode, forwards multipart/JSON unmodified to DeepSeek with backend auth and the deduplicated Files beta header; local multipart envelope cap is 65 MiB. Messages remain capped at 48 MiB.
- Known Chat/Completions/Responses/standalone Search/Fetch paths return 501 in non-Anthropic mode; these protocols are not translated into Messages.
- Other routes — pass through to `api.anthropic.com` unchanged.

**Native vision routing** — when the latest user message contains an Anthropic `image` block (including one nested in a Read `tool_result`), the proxy sends that request unchanged to DeepSeek using the production `deepseek-flash` model. Later text turns return to the selected code model, with stale image blocks replaced by placeholders. Request bodies are capped at DeepSeek's documented 48 MiB limit.

**Model name remapping** — `MODEL_REMAP` maps Claude model names to backend-specific names (e.g., `claude-opus-4-6` → `deepseek-flash` for direct DeepSeek, `deepseek/deepseek-v4-pro` for OpenRouter, or `minimax/minimax-m3:free` for the MiniMax backend). Short launcher aliases are normalized to canonical backend names.

**SSE normalization** — `UsageNormalizer` Transform stream. DeepSeek/OpenRouter may omit `usage` in `message_start`/`message_delta` SSE events, which crashes Claude Code. The normalizer injects zeroed usage fields when missing.

**Defensive SSE completion** — DeepSeek can emit a terminal `message_delta` while continuing transport-level `: keep-alive` comments without the required Anthropic `message_stop`. Once `stop_reason` is non-null and all content blocks are closed, the proxy allows a short grace period, synthesizes a missing `message_stop`, finalizes usage, and destroys the upstream socket. A separate semantic-progress watchdog ignores comments and `ping` events; it emits an SSE `api_error` and cancels a generation that has no meaningful event for `DEEPCLAUDE_SEMANTIC_TIMEOUT_MS` (120 seconds by default). Downstream disconnects also cancel upstream requests.

**Thinking compatibility** — direct DeepSeek retains historical thinking and native reasoning controls. Adaptive thinking maps to enabled; ignored budgets are removed. Other non-Anthropic routes retain the previous top-level thinking removal. For Anthropic mode after a non-Anthropic session, foreign thinking blocks are stripped because their signatures are invalid for Anthropic.

**Cost tracking** — tracks input/output and reported cache usage per backend. `/_proxy/cost` returns token cost estimates vs an Anthropic equivalent. Direct Flash uses peak prices; estimates exclude off-peak discounts and Search/Fetch request fees.

**Session logging** — launchers create one fresh `.deepclaude/logs/claude-<session-or-interactive>-<timestamp>-pid<PID>.log` per invocation and redirect proxy stderr there. Logs contain lifecycle, routing, HTTP/SSE errors, and shutdown events; secrets and full CLI arguments must not be logged. The directory is Git-ignored.

**Regression coverage** — run `node --test proxy/model-proxy.test.js proxy/deepseek-compat.test.js` (52 local tests as of 2026-10-29). The compatibility suite uses a mock upstream and blocks external destinations. Full audit: `docs/deepseek-compatibility.md`. Legacy title mocking is opt-in via `DEEPCLAUDE_MOCK_TITLE_GEN=1`; it is disabled by default because its heuristic can intercept actual user tasks. SSE decoding must preserve UTF-8 across chunks and must not reuse upstream content-length after normalization.

### `proxy/start-proxy.js`

CLI wrapper around `startModelProxy`. Two modes:
- **Legacy** (`start-proxy.js <targetUrl> <apiKey>`) — single backend, prints port to stdout. Used by shell scripts for remote mode.
- **Standalone** (`start-proxy.js --mode <name> --port <N>`) — multi-backend with live toggle. Reads keys from env vars.

## Tests and build

The proxy has dependency-free tests using Node's built-in test runner: `npm test`. There is no build/compile step. The launcher is Bash and the proxy is plain Node.js (ESM) with zero external runtime dependencies. Native Windows support has been removed; platform regression guards run in CI.

## Common patterns when editing

- **Launcher** — Bash is the only supported launcher; preserve its CLI/environment contracts.
- **Proxy** — `state` object holds current mode, target URL, API key. `switchMode()` mutates it. Server reads `state` on every request (no locking needed; single-threaded).
- **MODEL_REMAP** — when adding a new backend, update this table and the Bash launcher's `resolve_backend()`.
- **DeepSeek production model** — the direct DeepSeek backend maps every Claude Code tier and native image turn to `deepseek-flash`, currently V4.1-Flash-1017. Preserve DeepSeek thinking controls, reasoning history, and native server tool definitions/results. Compact window is 786432 per official integration docs. Cost tracking uses peak Flash token estimates with reported cache reads; excludes Search/Fetch fees and off-peak discounts. Standalone Search/Fetch JSON endpoints are not routed through Messages. Keep `DEEPCLAUDE_VISION_MODEL` configurable for compatibility testing.
- **Tool-schema sanitization** — non-Anthropic backends reject Claude Code tool `pattern` regexes that use Unicode property escapes (`\p{...}`, e.g. the Artifact tool) with 400 "not a regex". Before forwarding any non-Anthropic model call the proxy strips `pattern`/`patternProperties` from each tool's `input_schema` (`sanitizeToolSchemasForBackend`). Anthropic passthrough keeps them.
- **Control endpoints** — all under `/_proxy/` prefix. Never collides with `/v1/` API paths.
- **Backend URLs** — DeepSeek uses `x-api-key` header. OpenRouter, MiniMax, and Fireworks use `Authorization: Bearer`. The `useBearer` flag in backend config controls this.
