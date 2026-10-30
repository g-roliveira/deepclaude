# CLAUDE.md

Guidance for Claude Code and Codex working on this repository.

## Scope and architecture

deepclaude launches **Claude Code**, with DeepSeek through a Node HTTP proxy or
with native Anthropic authentication. Only DeepSeek and Anthropic are supported.
Bash on Linux is the supported launcher.

```text
deepclaude.sh → proxy/start-proxy.js → proxy/model-proxy.js
```

Normal and remote DeepSeek launches use the proxy. Native Anthropic launches
run claude or claude remote-control directly and must return after the child exits.
Never restart a user's active proxy merely to apply source changes.

## Launcher contract

Backend selectors: ds/deepseek and anthropic. DeepSeek requires DEEPSEEK_API_KEY.
The launcher sets ANTHROPIC_BASE_URL to localhost, ANTHROPIC_API_KEY to the
DeepSeek key in normal mode, and every model tier to deepseek-flash[1m].
Remote mode clears key/token overrides so the bridge can use Anthropic OAuth.
The compact window is 786432. Effort is optional.

Use -- to forward native Claude Code arguments. There is no provider-specific
model override; --model after -- belongs to Claude Code.
Native Anthropic mode clears launcher auth/endpoint/model overrides and relies on
Claude Code's managed login. Preserve exit status and trap-based log cleanup.

Each invocation writes a fresh ignored .deepclaude/logs/ file. Never log API keys,
full CLI arguments, prompts, tool arguments or image bytes.

## Proxy contracts

startModelProxy is a public export. Optional backends configuration contains only
a deepseek entry; Anthropic is native passthrough. Initial modes accept deepseek,
ds or anthropic; unknown modes/configuration entries reject before binding.
The historical _single label is an internal legacy accounting bucket, not an
additional provider.

- GET /_proxy/status: mode, uptime, requests.
- GET /_proxy/cost: DeepSeek text/vision token/cache estimates and Anthropic equivalent.
- POST /_proxy/mode: backend=deepseek (or ds) or anthropic. Unknown selectors fail
  without changing state; preserve localhost-origin restrictions.
- DeepSeek Messages: remap Claude tiers to deepseek-flash, normalize reasoning
  controls and tool schemas, preserve reasoning history and native server tools.
- Current user images, including nested tool_result images: validate signatures,
  route natively to DeepSeek, rewrite response model to the original client label.
  Replace historical images with placeholders on later turns.
- DeepSeek Files: preserve bytes/query/method, use DeepSeek x-api-key and deduplicated
  Files beta header. Cap multipart envelope at 65 MiB, Messages at 48 MiB.
- Known unsupported API families return 501 in DeepSeek mode; no protocol conversion.
- Anthropic and bridge traffic retain incoming authentication. DeepSeek requests
  replace incoming auth with x-api-key; never leak that key into bridge traffic.
- Switching from DeepSeek to Anthropic strips foreign thinking signatures.
  Native Anthropic thinking controls and valid redacted response blocks survive.

UsageNormalizer preserves UTF-8 across chunks, signatures, tool deltas and cache
metadata while supplying missing usage fields. Normalized responses cannot reuse
stale upstream content-length. When terminal intent and all closed blocks are
observed, synthesize a missing message_stop after a grace period. Never fabricate
completion before terminal intent. The semantic watchdog ignores keep-alives and
pings; downstream disconnect cancels upstream work. Drain in-flight work on shutdown.

Local count_tokens is an estimate including system, tools and messages. Legacy
title mocking is opt-in (DEEPCLAUDE_MOCK_TITLE_GEN=1), disabled by default.
Token costs use configured Flash peak estimates and exclude Search/Fetch fees.

## Verification and editing

Runtime is plain Node ESM with zero third-party dependencies; no build/typecheck.
Use npm test and npm run refactor:verify. Tests cover local mock upstreams, launcher
stubs, credentials, switching, vision/Files, reasoning/cache and SSE failures.
Native Windows launchers and retired providers are forbidden by the active policy.

For explicit removals, read .agents/skills/surgical-refactor/SKILL.md and follow
discovery, baseline, scoped AST review, regression verification and evidence report.
Claude Code uses the same skill via .claude/skills/surgical-refactor.
The policy in .surgical-refactor/config.json enforces the authorized removals;
do not regenerate the baseline to absorb regressions.

Development tools remain project-local and pinned. Mutation testing covers
buildUpstreamPath and startup provider-validation guards, not the entire proxy.
See docs/provider-removal.md and docs/deepseek-compatibility.md for evidence and gaps.
