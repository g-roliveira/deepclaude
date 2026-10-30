# Model Proxy for Remote Control

When using `claude remote-control`, the bridge authentication must go to Anthropic while model API calls go to DeepSeek. This proxy handles the split.

## How it works

```
claude remote-control
  ├── Bridge WebSocket → wss://bridge.claudeusercontent.com (Anthropic, hardcoded)
  └── Model API calls  → http://localhost:3200 (this proxy)
                            ├── /v1/messages → api.deepseek.com (with DeepSeek key)
                            └── everything else → api.anthropic.com (passthrough)
```

## Usage

```javascript
import { startModelProxy } from './model-proxy.js';

const proxy = await startModelProxy({
    targetUrl: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY,
    backends: { deepseek: { url: 'https://api.deepseek.com/anthropic', apiKey: process.env.DEEPSEEK_API_KEY } },
    defaultMode: 'deepseek',
});

console.log(`Proxy on port ${proxy.port}`);

// Set env vars for claude remote-control:
// ANTHROPIC_BASE_URL=http://127.0.0.1:${proxy.port}
// ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
// (do NOT set ANTHROPIC_AUTH_TOKEN — OAuth handles bridge auth)

// When done:
proxy.close();
```

Only DeepSeek and Anthropic modes are supported. The optional backend registry
contains only DeepSeek; Anthropic is native passthrough. Unknown initial modes
and registry names reject before the server starts. Switch with
`proxy.switchMode('deepseek')` or `proxy.switchMode('anthropic')`; the latter
requires valid incoming Anthropic credentials. There is no generic model override.

The Bash launcher uses this proxy in both normal and remote DeepSeek sessions.
It bypasses it for native `--backend anthropic` launches. DeepSeek Files requests
also go to DeepSeek; known unsupported API families return 501 instead of being
sent to Anthropic. See [current contracts](../CLAUDE.md).

## Why a proxy?

Claude Code's remote control uses two separate channels:
1. **Bridge** (WebSocket to `wss://bridge.claudeusercontent.com`) — hardcoded, needs Anthropic OAuth
2. **Model API** (HTTP to `ANTHROPIC_BASE_URL`) — configurable

Setting `ANTHROPIC_AUTH_TOKEN` to a DeepSeek key breaks the bridge. The proxy lets you keep Anthropic OAuth for the bridge while routing model calls to DeepSeek.
