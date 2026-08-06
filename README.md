# deepclaude (community fork)

Use Claude Code with **DeepSeek V4 Pro**, **OpenRouter**, **Fireworks AI**, or any Anthropic-compatible backend. Same UX, 17x cheaper. **Community-maintained with active improvements.**

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

The upstream repository has accumulated open PRs and issues with critical fixes. This fork applies those fixes, adds original improvements, and actively maintains the codebase. **PRs welcome.**

### Improvements over upstream

| Feature | Status | Description |
|---|---|---|
| **Image fallback** | New | Auto-reroutes vision turns to Anthropic or OpenRouter. DeepSeek doesn't support images — this keeps conversations going when you `Read` a PNG or screenshot. Configurable: `DEEPCLAUDE_IMAGE_FALLBACK=anthropic\|openrouter\|off` |
| **Model coverage** | Fixed | `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5` added. Tier-based fallback so new Claude models never silently route to the wrong backend. |
| **Proxy resilience** | Fixed | Upstream TCP resets no longer crash the proxy. SSE corruption on mid-stream errors eliminated. |
| **Thinking-block continuity** | Fixed | DeepSeek 400 error mid-conversation (`content[].thinking must be passed back`) resolved. |
| **Cost tracking everywhere** | Fixed | Proxy runs in all modes (not just `--remote`). `/_proxy/cost` and live `/switch` work in normal sessions. |
| **Telemetry mocking** | New | Title generation and count_tokens requests answered locally — saves API round-trips. |
| **Redacted thinking strip** | New | Filters `redacted_thinking` blocks OpenRouter emits for non-Claude models (breaks the SSE parser). |
| **Body size limit** | Security | 50 MB cap on request bodies. Returns 413 instead of consuming unbounded memory. |
| **Forward unknown args** | Fixed | `deepclaude -p "msg"` and `deepclaude --dangerously-skip-permissions` now work — unknown flags pass through to `claude`. |
| **PowerShell parity** | Fixed | `--switch/-s` works. `try/finally` cleanup on Ctrl+C. `ValueFromRemainingArguments` forwards unknown args. |
| **[1m] context hint** | Fixed | Model names include `[1m]` suffix so Claude Code doesn't auto-compact at 200k tokens. |
| **Documented architecture** | New | `CLAUDE.md` with proxy routing, SSE normalization, model remapping, and development conventions. |

## Quick start (2 minutes)

### 1. Get a DeepSeek API key

Sign up at [platform.deepseek.com](https://platform.deepseek.com), add $5 credit, copy your API key.

### 2. Set environment variables

**Windows (PowerShell):**
```powershell
setx DEEPSEEK_API_KEY "sk-your-key-here"
```

**macOS/Linux:**
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
deepclaude                  # Launch Claude Code with DeepSeek V4 Pro
deepclaude --status         # Show available backends and keys
deepclaude --backend or     # Use OpenRouter (cheapest, $0.44/M input)
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

### Image fallback architecture

When a non-Anthropic backend receives an image (DeepSeek's compat endpoint returns 400), the proxy detects it and reroutes that single turn:

```
Text turn:
  Claude Code -> proxy -> DeepSeek ($0.87/M)

Image turn (Read PNG, screenshot):
  Claude Code -> proxy detects image -> Anthropic/OpenRouter (vision-capable)
  Model name swapped on wire, swapped back on response
  Claude Code never sees the switch

Next text turn:
  Claude Code -> proxy -> DeepSeek (back to cheap backend)
  Stale images stripped from history so they don't pin to fallback
```

## Supported backends

| Backend | Flag | Input/M | Output/M | Servers | Notes |
|---|---|---|---|---|---|
| **DeepSeek** (default) | `--backend ds` | $0.44 | $0.87 | China | Auto context caching (110x cheaper on repeat turns) |
| **OpenRouter** | `--backend or` | $0.44 | $0.87 | US | Cheapest, lowest latency from US/EU |
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
| `CHEAPCLAUDE_DEFAULT_BACKEND` | `ds` | Default backend (`ds`, `or`, `fw`, `anthropic`) |
| `DEEPCLAUDE_IMAGE_FALLBACK` | `anthropic` | Image reroute target: `anthropic`, `openrouter`, or `off` |
| `DEEPCLAUDE_IMAGE_MODEL` | `google/gemini-2.5-flash` | Vision model for OpenRouter fallback |

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
    "anthropic_max": {
      "input_tokens": 8000,
      "output_tokens": 500,
      "requests": 1,
      "cost": 0,
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
- Image fallback design (detection, routing, model swap, history stripping)

## What works and what doesn't

### Works
- File reading, writing, editing (Read/Write/Edit tools)
- Bash/PowerShell execution
- Glob and Grep search
- Multi-step autonomous tool loops
- Subagent spawning
- Git operations
- Project initialization (`/init`)
- Thinking mode (enabled by default)
- **Image input** via automatic fallback (reroutes to Anthropic/OpenRouter)
- Mid-session backend switching
- Cost tracking in all modes
- PowerShell (full parity with bash)

### Doesn't work or degraded
| Feature | Reason |
|---|---|
| Image/vision on DeepSeek directly | DeepSeek's Anthropic endpoint doesn't support images. **Mitigated:** auto-fallback to Anthropic/OpenRouter. |
| MCP server tools | Not supported through compatibility layer |
| Anthropic prompt caching | DeepSeek has its own caching (automatic), but Anthropic's `cache_control` is ignored |

### Intelligence difference
- **Routine tasks** (80% of work): DeepSeek V4 Pro is comparable to Claude Opus
- **Complex reasoning** (20%): Claude Opus is stronger — switch with `--backend anthropic`
- **Vision tasks**: Auto-routed to Anthropic (Max subscription) or OpenRouter (configurable)

## License

MIT

---

🤖 Community fork maintained at [github.com/g-roliveira/deepclaude](https://github.com/g-roliveira/deepclaude). PRs welcome.
