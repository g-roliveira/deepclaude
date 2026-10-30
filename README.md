# deepclaude (community fork)

The supported launcher is Bash on Linux. Native Windows/PowerShell support has
been removed. The shared Node proxy and all model backends remain available.

Use Claude Code with **DeepSeek V4 Pro**, **MiniMax M3 Free via OpenRouter**, **OpenRouter**, **Fireworks AI**, or any Anthropic-compatible backend. Same UX, 17x cheaper. **Community-maintained with active improvements.**

> This is a community fork of [aattaran/deepclaude](https://github.com/aattaran/deepclaude) with bug fixes, new features, and expanded model coverage merged from open PRs and original development.

![Remote control running DeepSeek V4 Pro in the browser](screenshots/remote-control-deepseek.png)

## What this does

Claude Code is the best autonomous coding agent — but Anthropic's API costs $200/month with usage caps. DeepSeek V4 Pro scores 96.4% on LiveCodeBench and costs $0.87/M output tokens.

**deepclaude** swaps the brain while keeping the body:

```
Your terminal
  +-- Claude Code CLI (tool loop, file editing, bash, git - unchanged)
        +-- API calls -> DeepSeek V4 Pro ($0.87/M) instead of Anthropic ($15/M)
```

Everything works: file reading, editing, bash execution, subagent spawning, autonomous multi-step coding loops. The only difference is which model thinks.

## Why this fork

This repository includes a project-local [Surgical Refactor skill](docs/surgical-refactor.md)
for Claude Code and Codex: AST/dependency analysis, regression baselines,
forbidden-reference guards, and focused mutation testing. It does not remove any
provider merely by being installed.

The upstream repository has accumulated open PRs and issues with critical fixes. This fork applies those fixes, adds original improvements, and actively maintains the codebase. **PRs welcome.**

### Improvements over upstream

| Feature | Status | Description |
|---|---|---|
| **Native DeepSeek Vision** | New | Automatically routes a fresh image turn to production `deepseek-flash` through DeepSeek's Anthropic-compatible API. No Gemini, OpenRouter, Anthropic quota, or format translation required. |
| **Model coverage** | Fixed | `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5` added. Tier-based fallback so new Claude models never silently route to the wrong backend. |
| **Proxy resilience** | Fixed | TCP resets no longer crash the proxy. Missing `message_stop` events are recovered, stalled generations are detected even when keep-alives continue, and abandoned downstream requests cancel their upstream sockets. |
| **Thinking-block continuity** | Fixed | DeepSeek 400 error mid-conversation (`content[].thinking must be passed back`) resolved. |
| **Cost tracking everywhere** | Fixed | Proxy runs in all modes (not just `--remote`). `/_proxy/cost` and live `/switch` work in normal sessions. |
| **Local token estimates** | New | Counts system, tool schemas and messages locally. Legacy title mocking is disabled by default to avoid intercepting real tasks. |
| **Redacted thinking strip** | New | Filters `redacted_thinking` blocks OpenRouter emits for non-Claude models (breaks the SSE parser). |
| **Body size limit** | Security | 48 MiB cap, aligned with DeepSeek's documented API limit. Returns 413 locally instead of consuming unbounded memory or failing upstream. |
| **Forward unknown args** | Fixed | `deepclaude -p "msg"` and `deepclaude --dangerously-skip-permissions` now work — unknown flags pass through to `claude`. |
| **[1m] context hint** | Fixed | Model names include `[1m]` suffix so Claude Code doesn't auto-compact at 200k tokens. |
| **Documented architecture** | New | `CLAUDE.md` with proxy routing, SSE normalization, model remapping, and development conventions. |

## Quick start (2 minutes)

### DeepSeek V4.1 Flash (1017)

The direct DeepSeek backend uses the rolling `deepseek-flash` alias (currently
V4.1-Flash-1017). The Bash launcher uses the official Claude Code compaction
window of **786432** tokens. Custom OpenRouter models retain the conservative
200000 window. Token counting is a local UTF-8 estimate including messages,
system instructions and tool schemas, not DeepSeek's tokenizer or a guarantee
that a large request fits.

DeepSeek reasoning controls are preserved: adaptive thinking maps to enabled,
the ignored `budget_tokens` is removed, and effort maps to `low`, `high` or
`max`. Existing reasoning history and native server tool definitions/results
are forwarded.

**Search and Fetch:** DeepSeek provides `POST /v1/tools/search` for structured
web results and `POST /v1/tools/fetch` for page Markdown. These standalone JSON
APIs use Bearer authentication at `https://api.deepseek.com`; they are separate
from this proxy's Messages endpoint. Claude Code WebSearch is supported by the
DeepSeek Anthropic endpoint when Claude Code exposes the tool and the model
calls it. No separate search agent is installed by deepclaude. Claude Code's
WebFetch implementation is distinct from invoking the standalone Fetch API;
the proxy does not automatically replace it with that API.

Search/Fetch server-side calls become billable on November 1, 2026 (Beijing
time), at **$0.75 per 1000 successful calls**, in addition to model tokens.
`/_proxy/cost` uses Flash peak token prices ($0.30/M uncached input,
$0.006/M cache reads, $1.20/M output), includes reported cache usage and labels
the result as an estimate excluding Search/Fetch fees. Off-peak rates are half
those prices; this is not an invoice.

Sources: [Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/),
[Anthropic compatibility](https://api-docs.deepseek.com/guides/anthropic_api/),
[Search & Fetch](https://api-docs.deepseek.com/guides/search/),
[pricing](https://api-docs.deepseek.com/quick_start/pricing/).

See the [12-feature compatibility audit](docs/deepseek-compatibility.md) for
the supported Messages/Files paths, regression tests, separate API families and
live-validation gaps. Run all local regressions with:

```bash
node --test proxy/model-proxy.test.js proxy/deepseek-compat.test.js
```

DeepSeek-selected sessions now route Anthropic Files operations to DeepSeek,
with a 65 MiB multipart envelope cap (Messages remain limited to 48 MiB).
Unsupported OpenAI/Responses/standalone Search/Fetch paths return 501 locally
in non-Anthropic mode rather than following the Anthropic fallback. Legacy
title mocking requires explicit `DEEPCLAUDE_MOCK_TITLE_GEN=1`; leave it unset
for normal tasks.

### 1. Get a DeepSeek API key

Sign up at [platform.deepseek.com](https://platform.deepseek.com), add $5 credit, copy your API key.

### 2. Set environment variables

**Bash/Linux:**
```bash
echo 'export DEEPSEEK_API_KEY="sk-your-key-here"' >> ~/.bashrc
source ~/.bashrc
```

### 3. Install

```bash
git clone https://github.com/g-roliveira/deepclaude.git
cd deepclaude
chmod +x deepclaude.sh
sudo ln -s "$(pwd)/deepclaude.sh" /usr/local/bin/deepclaude
```

### 4. Use it

```bash
deepclaude                  # Launch Claude Code with DeepSeek V4.1 Flash
deepclaude --status         # Show available backends and keys
deepclaude --backend or     # Use OpenRouter (cheapest, $0.44/M input)
deepclaude --backend op --model inclusionai/ling-3.0-flash-sante:free  # Any OpenRouter model
deepclaude --backend mm     # Use MiniMax M3 Free through OpenRouter
deepclaude --backend fw     # Use Fireworks AI (fastest, US servers)
deepclaude --backend anthropic  # Normal Claude Code (when you need Opus)
deepclaude --cost           # Show pricing comparison
deepclaude --benchmark      # Latency test across all providers
deepclaude --switch ds      # Switch backend mid-session (no restart)
```

### 5. Live switching (mid-session)

From inside Claude Code, or from another terminal:

```bash
deepclaude --switch deepseek    # Switch to DeepSeek
deepclaude --switch anthropic   # Switch to Anthropic
deepclaude --switch or          # Switch to OpenRouter
```

Or query the proxy directly:
```bash
curl -sX POST http://127.0.0.1:3200/_proxy/mode -d "backend=deepseek"
curl -s http://127.0.0.1:3200/_proxy/status
curl -s http://127.0.0.1:3200/_proxy/cost
```

## How it works

Claude Code reads these environment variables to determine where to send API calls:

| Variable | What it does |
|---|---|
| `ANTHROPIC_BASE_URL` | API endpoint (default: api.anthropic.com) |
| `ANTHROPIC_API_KEY` | API key for the backend |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Model name for Opus-tier tasks |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Model name for Sonnet-tier tasks |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Model name for Haiku-tier (subagents) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Model for spawned subagents |

**deepclaude** starts a local proxy on `127.0.0.1:3200`, sets these env vars per-session, launches Claude Code, then restores your original settings on exit.

```
Claude Code -> localhost:3200 (proxy)
                 |
                 +-- /_proxy/mode POST -> switch backend
                 +-- /_proxy/status GET -> current backend + uptime
                 +-- /_proxy/cost GET -> token usage + cost savings
                 |
                 +-- /v1/messages -> active backend (DeepSeek/OpenRouter/Anthropic)
                 +-- /v1/messages/count_tokens -> mock (local, saves round-trip)
                 +-- everything else -> Anthropic (passthrough)
```

### Native vision architecture

DeepSeek now accepts Anthropic-format image blocks directly. The proxy detects an image in the latest user message and changes only the model for that request:

```
Text turn:
  Claude Code -> proxy -> DeepSeek ($0.87/M)

Image turn (Read PNG, screenshot):
  Claude Code -> proxy -> deepseek-flash
  Anthropic image block is forwarded unchanged
  Response model name is restored for Claude Code
  Claude Code never sees the switch

Next text turn:
  Claude Code -> proxy -> DeepSeek (back to cheap backend)
  Stale images stripped from history so they don't pin later turns to Vision
```

Supported formats are JPEG, PNG, GIF, and WebP. The DeepSeek API allows a 48 MiB request body, up to 32 MiB per inline image, and up to 600 images per request. Vision is currently an experimental model; set `DEEPCLAUDE_VISION_MODEL` if DeepSeek changes its model ID.

### Defensive SSE completion

DeepSeek may keep an SSE connection alive with `: keep-alive` comments after semantic generation has stopped. The proxy handles both failure modes safely:

- After a non-null `stop_reason` and all content blocks have closed, it waits briefly for the required `message_stop`. If absent, the proxy synthesizes it and completes normally.
- If generation stops before terminal intent, a semantic-progress watchdog ignores transport-only comments and `ping` events. After two minutes without a real SSE event, the proxy returns an explicit `api_error` and cancels the upstream connection instead of leaving Claude Code waiting for roughly 12 minutes.

A Claude Code disconnect also cancels its corresponding DeepSeek request. Set `DEEPCLAUDE_SEMANTIC_TIMEOUT_MS` to tune the watchdog, or `0` to disable it.

## Supported backends

| Backend | Flag | Input/M | Output/M | Servers | Notes |
|---|---|---|---|---|---|
| **DeepSeek** (default) | `--backend ds` | $0.44 | $0.87 | China | Auto context caching (110x cheaper on repeat turns) |
| **MiniMax M3 Free** | `--backend mm` | $0 | $0 | OpenRouter | Free tier; subject to OpenRouter availability/rate limits |
| **OpenRouter** | `--backend or` | $0.44 | $0.87 | US | DeepSeek via OpenRouter; lowest latency from US/EU |
| **OpenRouter custom** | `--backend op --model <id>` | provider | provider | US | Any OpenRouter model ID, including `:free` variants |
| **Fireworks AI** | `--backend fw` | $1.74 | $3.48 | US | Fastest inference |
| **Anthropic** | `--backend anthropic` | $3.00 | $15.00 | US | Original Claude (for hard problems) |

### Model mapping

Claude Code model names are automatically remapped to backend-specific names:

| Claude Code model | DeepSeek | OpenRouter |
|---|---|---|
| `claude-fable-5` | `deepseek-v4-pro[1m]` | `deepseek/deepseek-v4-pro[1m]` |
| `claude-opus-5` | `deepseek-v4-pro[1m]` | `deepseek/deepseek-v4-pro[1m]` |
| `claude-opus-4-8` | `deepseek-v4-pro[1m]` | `deepseek/deepseek-v4-pro[1m]` |
| `claude-sonnet-5` | `deepseek-v4-flash[1m]` | `deepseek/deepseek-v4-flash[1m]` |
| `claude-haiku-4.5` | `deepseek-v4-flash[1m]` | `deepseek/deepseek-v4-flash[1m]` |

New Claude models that aren't explicitly listed fall back by tier (fable/opus/sonnet/haiku) — they'll work, just with a log warning.

### MiniMax M3 Free on OpenRouter

Use the `mm` backend to route all Claude Code model tiers to OpenRouter's free MiniMax model:

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
deepclaude --backend mm
```

The proxy sends `minimax/minimax-m3:free` through OpenRouter's Anthropic-compatible `/v1/messages` endpoint. Streaming, tools, and reasoning are passed through; OpenRouter's free-model availability and rate limits still apply. The existing `or` backend remains available for OpenRouter's DeepSeek route.

### Any OpenRouter model

The `op` backend accepts an explicit OpenRouter model ID, including free variants:

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
deepclaude --backend op --model "inclusionai/ling-3.0-flash-sante:free"
```

The model override is applied to every Claude Code model tier for that session. Claude Code keeps a recognized internal model label while the proxy replaces it on the wire with the OpenRouter ID. Custom models use a conservative 200k auto-compaction window unless their own launcher configuration is added later; this avoids assuming that every OpenRouter model supports 1M context.

### DeepSeek V4.1 Flash (production)

DeepSeek now recommends the stable alias `deepseek-flash`. It is the production V4.1 Flash model and supports 1M context, up to 384K output, tool calls, reasoning, Anthropic API requests, and native vision:

```bash
export DEEPSEEK_API_KEY="..."
deepclaude                  # uses deepseek-flash for every Claude Code tier
deepclaude --remote         # remote control with the production model
```

The expired beta `deepseek-v4.1-flash-expires-on-0910` is no longer used. Legacy names remain temporarily accepted by DeepSeek, but the proxy sends the stable production alias directly.

## Configuration

### Required

| Variable | Backend |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek (default) |
| `OPENROUTER_API_KEY` | OpenRouter |
| `FIREWORKS_API_KEY` | Fireworks AI |

### Optional

| Variable | Default | Description |
|---|---|---|
| `CHEAPCLAUDE_DEFAULT_BACKEND` | `ds` | Default backend (`ds`, `or`, `op`, `mm`, `fw`, `anthropic`) |
| `DEEPCLAUDE_VISION_MODEL` | `deepseek-flash` | DeepSeek model used for image turns |
| `DEEPCLAUDE_SEMANTIC_TIMEOUT_MS` | `120000` | Abort an SSE generation after this long without semantic progress; transport keep-alives do not reset it (`0` disables) |

### Session logs

Each launcher start creates a new local log under `.deepclaude/logs/` in the repository. The filename includes the explicit `--resume` session ID when provided, or `interactive` when Claude Code's session picker is used, plus the start time and launcher PID. Proxy errors, HTTP status failures, SSE parse errors, and clean shutdown are recorded; API keys and full Claude arguments are never written. Logs are local and ignored by Git.

## Cost comparison

| Usage level | Anthropic Max | deepclaude (DeepSeek) | Savings |
|---|---|---|---|
| Light (10 days/mo) | $200/mo (capped) | ~$20/mo | 90% |
| Heavy (25 days/mo) | $200/mo (capped) | ~$50/mo | 75% |
| With auto loops | $200/mo (capped) | ~$80/mo | 60% |

DeepSeek's automatic context caching makes agent loops extremely cheap — after the first request, the system prompt and file context are cached at $0.004/M (vs $0.44/M uncached).

### Cost tracking

The proxy tracks token usage and calculates savings vs Anthropic pricing:

```bash
curl -s http://127.0.0.1:3200/_proxy/cost
```

Returns:
```json
{
  "backends": {
    "deepseek": {
      "input_tokens": 125000,
      "output_tokens": 45000,
      "requests": 12,
      "cost": 0.0941,
      "anthropic_equivalent": 1.05
    },
    "deepseek_vision": {
      "input_tokens": 8000,
      "output_tokens": 500,
      "requests": 1,
      "cost": 0.0042,
      "anthropic_equivalent": 0.0315
    }
  },
  "total_cost": 0.0941,
  "anthropic_equivalent": 1.0815,
  "savings": 0.9874
}
```

## Live switching (no restart)

Switch between Anthropic and DeepSeek **mid-session** — from inside Claude Code itself. No restart, no terminal commands.

```bash
# From another terminal:
deepclaude --switch deepseek
deepclaude --switch anthropic

# Or via curl:
curl -sX POST http://127.0.0.1:3200/_proxy/mode -d "backend=deepseek"
```

## Remote control (`--remote`)

Open a Claude Code session in any browser — with DeepSeek as the brain:

```bash
deepclaude --remote                # Remote control + DeepSeek
deepclaude --remote -b or          # Remote control + OpenRouter
deepclaude --remote -b anthropic   # Remote control + Anthropic (normal)
```

### Prerequisites
- Must be logged into Claude Code: `claude auth login`
- Must have a claude.ai subscription (the bridge is Anthropic infrastructure)
- Node.js 18+ (for the proxy)

## Project architecture

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation covering:
- Proxy routing logic (`/_proxy/*` control endpoints, `/v1/messages` routing)
- SSE normalization (`UsageNormalizer` — injects missing `usage` fields)
- Model name remapping (`MODEL_REMAP` + tier-based fallback)
- Thinking block handling (continuity for DeepSeek, strip on backend switch)
- Native vision routing (detection, model swap, response rewrite, history stripping)

## What works and what doesn't

### Works
- File reading, writing, editing (Read/Write/Edit tools)
- Bash execution
- Glob and Grep search
- Multi-step autonomous tool loops
- Subagent spawning
- Git operations
- Project initialization (`/init`)
- Thinking mode (enabled by default)
- **Image input** via DeepSeek's native `deepseek-flash`
- Mid-session backend switching
- Cost tracking in all modes

### Doesn't work or degraded
| Feature | Reason |
|---|---|
| Vision model stability | `deepseek-flash` is the stable production alias. Override it with `DEEPCLAUDE_VISION_MODEL` only when testing another compatible model. |
| MCP server tools | Not supported through compatibility layer |
| Anthropic prompt caching | DeepSeek has its own caching (automatic), but Anthropic's `cache_control` is ignored |

### Intelligence difference
- **Routine tasks** (80% of work): DeepSeek V4 Pro is comparable to Claude Opus
- **Complex reasoning** (20%): Claude Opus is stronger — switch with `--backend anthropic`
- **Vision tasks**: Auto-routed to DeepSeek Vision; subsequent text turns return to the selected code model

## License

MIT

---

🤖 Community fork maintained at [github.com/g-roliveira/deepclaude](https://github.com/g-roliveira/deepclaude). PRs welcome.
