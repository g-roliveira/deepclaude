# deepclaude (community fork)

Run Claude Code with **DeepSeek** through a local proxy, or launch it with its
native **Anthropic** backend. Bash on Linux is the supported launcher.

Community fork of [aattaran/deepclaude](https://github.com/aattaran/deepclaude),
maintained at [g-roliveira/deepclaude](https://github.com/g-roliveira/deepclaude).

## Quick start

Install Claude Code and Node.js, then:

```bash
git clone https://github.com/g-roliveira/deepclaude.git
cd deepclaude
chmod +x deepclaude.sh
mkdir -p ~/.local/bin
ln -s "$(pwd)/deepclaude.sh" ~/.local/bin/deepclaude
export DEEPSEEK_API_KEY="your-key"
deepclaude
```

Keep your API key in your private shell configuration, outside the repository.
For Zsh, load it from your private secrets file or ~/.zshrc; for Bash, use your
private secrets file or ~/.bashrc. Ensure ~/.local/bin is in PATH.

```bash
deepclaude                                  # DeepSeek, all model tiers
deepclaude --resume                         # Claude Code session picker
deepclaude --effort max -- --resume
deepclaude --backend anthropic              # Native Claude Code login
deepclaude --remote                         # DeepSeek + Anthropic remote bridge
deepclaude --remote --backend anthropic
deepclaude --status
deepclaude --cost
deepclaude --benchmark                      # One billable DeepSeek request
```

Only `ds` (alias `deepseek`) and `anthropic` are supported backends.
Removed provider selectors fail explicitly. Native Claude Code arguments can be
passed after `--`, including `--model`; the proxy has no generic model override.

## What the proxy preserves

| Capability | Behavior |
| --- | --- |
| Production model | DeepSeek sessions use the rolling `deepseek-flash` alias for every model tier |
| Native vision | Validates current user images, including Read tool results, and sends Anthropic image blocks directly to DeepSeek |
| Reasoning continuity | Preserves historical thinking/signatures and native tool results; maps adaptive thinking to enabled |
| Effort | Maps Claude effort to DeepSeek low/high/max; removes ignored thinking budgets |
| Context headroom | Launcher sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`; model labels include `[1m]` |
| Files | Routes DeepSeek Files operations with backend authentication and the Files beta header |
| Streaming | Preserves UTF-8, tool arguments, signatures, usage and cache metadata |
| Stall handling | Detects semantic stalls despite keep-alives; safely recovers missing terminal events |
| Cancellation | Cancels upstream work when the client disconnects and drains on shutdown |
| Usage and cost | Tracks DeepSeek text/vision token usage and cache reads as estimates |
| Session logs | Creates a new ignored local log on each launcher invocation |

Vision supports JPEG, PNG, GIF and WebP. Messages are capped at 48 MiB, inline
images at 32 MiB each, with up to 600 images. The Files multipart envelope cap
is 65 MiB. Older image blocks become placeholders on later turns. Both text and
vision currently use the same production alias.

Local token counting includes system instructions, tools and messages, but is
an estimate, not DeepSeek's tokenizer. Compaction headroom reduces overflow risk;
it does not guarantee that arbitrary tool results fit the model window.

Legacy title mocking is disabled by default. Leave
`DEEPCLAUDE_MOCK_TITLE_GEN` unset for normal work.

## Routing and authentication

```text
deepclaude.sh
  └─ Claude Code → local Node proxy
       ├─ Messages / Files → DeepSeek with x-api-key
       ├─ local controls → status, mode, cost
       └─ Anthropic mode / bridge traffic → Anthropic with incoming auth
```

Normal and remote DeepSeek launches use the proxy. A native
`--backend anthropic` launch runs Claude Code directly and returns when it exits.
The launcher clears its endpoint/key overrides for that native launch; use your
Claude Code managed login. The remote bridge also requires Anthropic authentication.

For an existing proxy, use:

```bash
deepclaude --switch ds
deepclaude --switch anthropic
curl -s http://127.0.0.1:3200/_proxy/status
curl -s http://127.0.0.1:3200/_proxy/cost
```

The control command addresses port 3200. If several proxies are running, use the
port printed by your launcher with curl instead. Anthropic passthrough requires
valid incoming Anthropic credentials; switching does not turn a DeepSeek key
into an Anthropic credential.

DeepSeek reasoning history stays intact. When switching from DeepSeek to
Anthropic, foreign thinking blocks are removed to avoid invalid signatures.
Valid response blocks, including redacted thinking, are preserved.

## Search, Fetch and API families

Native server tools and their results are forwarded through Messages. The proxy
does not implement an independent search agent or translate Chat Completions,
Responses, FIM, prefix completion, or standalone Search/Fetch APIs. Known paths
for those protocols return 501 in DeepSeek mode.

See the [DeepSeek compatibility audit](docs/deepseek-compatibility.md) for the
tested Messages/Files contracts and live-validation gaps. API references:
[Anthropic compatibility](https://api-docs.deepseek.com/guides/anthropic_api/),
[vision](https://api-docs.deepseek.com/guides/vision/),
[Search & Fetch](https://api-docs.deepseek.com/guides/search/).

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | Required for DeepSeek |
| `CHEAPCLAUDE_DEFAULT_BACKEND` | `ds`; accepts ds/deepseek/anthropic |
| `DEEPCLAUDE_SEMANTIC_TIMEOUT_MS` | 120000 ms without semantic progress; 0 disables the watchdog |
| `DEEPCLAUDE_MOCK_TITLE_GEN` | Disabled unless explicitly set to 1 |

The programmatic proxy accepts `DEEPCLAUDE_VISION_MODEL` for compatible model
experiments. The launcher explicitly selects `deepseek-flash`.

Each start writes a fresh `.deepclaude/logs/claude-<session>-<timestamp>-pid<PID>.log`.
Explicit resume IDs appear in the name; the interactive picker uses
`interactive`. Logs contain routing/error metadata, not full prompts or API keys.

`/_proxy/cost` uses configured peak token estimates: $0.30/M uncached input,
$0.006/M cache reads and $1.20/M output. It excludes standalone Search/Fetch
charges and off-peak discounts. The Anthropic comparison is illustrative,
not a subscription price or invoice. Confirm current rates with your provider.

## Development and regression checks

Runtime uses Node built-ins with no third-party dependencies and no build step.

```bash
npm test
npm run refactor:setup          # Install pinned, project-local analysis tools
npm run refactor:verify         # Tests, coverage, AST, static analysis, guards
npm run refactor:mutation       # Focused path and provider-validation mutation gate
```

The [project-local Surgical Refactor skill](docs/surgical-refactor.md) works with
Claude Code and Codex. CI guards the removed platform/provider code and rejects
new dead-code findings. Tests use local mock upstreams; they do not certify live
provider availability.

See [architecture and editing guidance](CLAUDE.md) and the
[provider removal evidence](docs/provider-removal.md).

## License

MIT
