import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { Transform } from 'stream';

const ANTHROPIC_FALLBACK = 'https://api.anthropic.com';
const MODEL_PATHS = ['/v1/messages'];
const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50 MB
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per request

// Image fallback: when a non-Anthropic backend receives an image (which
// DeepSeek's compat endpoint rejects with 400), reroute that single turn
// to a vision-capable provider, then return to the normal backend.
// DEEPCLAUDE_IMAGE_FALLBACK:
//   anthropic (default) — uses existing Claude Code auth (Max subscription)
//   openrouter — uses OPENROUTER_API_KEY + DEEPCLAUDE_IMAGE_MODEL
//   gemini — uses DEEPCLAUDE_GEMINI_API_KEY + DEEPCLAUDE_GEMINI_MODEL
//            direct Google AI Studio (fastest, free tier)
//   off — disables fallback
const IMAGE_FALLBACK = process.env.DEEPCLAUDE_IMAGE_FALLBACK || 'anthropic';
const IMAGE_FALLBACK_ENABLED = IMAGE_FALLBACK !== 'off';
const IMAGE_FALLBACK_MODEL = process.env.DEEPCLAUDE_IMAGE_MODEL || 'google/gemini-2.5-flash';
const GEMINI_MODEL = process.env.DEEPCLAUDE_GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.DEEPCLAUDE_GEMINI_API_KEY || '';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const MODEL_REMAP = {
    deepseek: {
        _default: { fable: 'deepseek-v4-pro', opus: 'deepseek-v4-pro', sonnet: 'deepseek-v4-flash', haiku: 'deepseek-v4-flash' },
        'claude-fable-5':     'deepseek-v4-pro',
        'claude-opus-5':      'deepseek-v4-pro',
        'claude-opus-4-6':    'deepseek-v4-pro',
        'claude-opus-4-7':    'deepseek-v4-pro',
        'claude-opus-4-8':    'deepseek-v4-pro',
        'claude-sonnet-5':    'deepseek-v4-flash',
        'claude-sonnet-4-6':  'deepseek-v4-flash',
        'claude-sonnet-4-5-20250929': 'deepseek-v4-flash',
        'claude-haiku-4-5-20251001':  'deepseek-v4-flash',
    },
    openrouter: {
        _default: { fable: 'deepseek/deepseek-v4-pro', opus: 'deepseek/deepseek-v4-pro', sonnet: 'deepseek/deepseek-v4-flash', haiku: 'deepseek/deepseek-v4-flash' },
        'claude-fable-5':     'deepseek/deepseek-v4-pro',
        'claude-opus-5':      'deepseek/deepseek-v4-pro',
        'claude-opus-4-6':    'deepseek/deepseek-v4-pro',
        'claude-opus-4-7':    'deepseek/deepseek-v4-pro',
        'claude-opus-4-8':    'deepseek/deepseek-v4-pro',
        'claude-sonnet-5':    'deepseek/deepseek-v4-flash',
        'claude-sonnet-4-6':  'deepseek/deepseek-v4-flash',
        'claude-sonnet-4-5-20250929': 'deepseek/deepseek-v4-flash',
        'claude-haiku-4-5-20251001':  'deepseek/deepseek-v4-flash',
    },
};

// Many-to-one collisions in MODEL_REMAP collapse last-write-wins.
// Used on the image-fallback path to swap backend model names back
// to canonical Claude names on the wire.
const REVERSE_MODEL_REMAP = {};
for (const [backend, table] of Object.entries(MODEL_REMAP)) {
    REVERSE_MODEL_REMAP[backend] = {};
    for (const [claudeName, backendName] of Object.entries(table)) {
        if (claudeName === '_default') continue;
        REVERSE_MODEL_REMAP[backend][backendName] = claudeName;
    }
}

const PRICING_PER_M = {
    deepseek:       { input: 0.44,  output: 0.87 },
    openrouter:     { input: 0.44,  output: 0.87 },
    fireworks:      { input: 1.74,  output: 3.48 },
    anthropic:      { input: 3.00,  output: 15.00 },
    anthropic_max:  { input: 0,     output: 0 },     // Max subscription quota
    gemini:         { input: 0,     output: 0 },     // Google AI Studio free tier
    image_fallback: { input: 0.15,  output: 0.60 },   // Gemini Flash via OpenRouter
    _single:        { input: 0.44,  output: 0.87 },
};

/**
 * Transform stream that intercepts SSE events and injects missing `usage`
 * fields. DeepSeek/OpenRouter may omit `usage` in message_start or
 * message_delta, which crashes Claude Code ("$.input_tokens" is undefined).
 */
class UsageNormalizer extends Transform {
    constructor(onUsage, { modelRewrite } = {}) {
        super();
        this._buf = '';
        this._onUsage = onUsage;
        this._inputTokens = 0;
        this._outputTokens = 0;
        this._modelRewrite = modelRewrite || null;
    }

    _transform(chunk, _enc, cb) {
        this._buf += chunk.toString();
        const parts = this._buf.split('\n\n');
        this._buf = parts.pop();
        for (const part of parts) {
            this.push(this._fix(part) + '\n\n');
        }
        cb();
    }

    _fix(event) {
        const m = event.match(/^data: (.+)$/m);
        if (!m) return event;
        try {
            const d = JSON.parse(m[1]);
            let changed = false;

            // Strip redacted_thinking blocks that OpenRouter emits out-of-order
            // for non-Claude reasoning models. These break the SSE parser.
            if (d.type === 'content_block_start' || d.type === 'content_block_delta') {
                if (d.content_block?.type === 'redacted_thinking') {
                    return ''; // drop the event entirely
                }
            }

            if (d.type === 'message_start' && d.message) {
                if (d.message.usage) {
                    this._inputTokens = d.message.usage.input_tokens || 0;
                } else {
                    d.message.usage = { input_tokens: 0, output_tokens: 0 };
                    changed = true;
                }
                // Rewrite model name on the response side so Claude Code
                // sees the backend model it expects, not the canonical
                // Claude name used on the image-fallback wire.
                if (this._modelRewrite && d.message.model === this._modelRewrite.from) {
                    d.message.model = this._modelRewrite.to;
                    changed = true;
                }
            }
            if (d.type === 'message_delta') {
                if (d.usage) {
                    this._outputTokens = d.usage.output_tokens || 0;
                } else {
                    d.usage = { output_tokens: 0 };
                    changed = true;
                }
            }
            if (changed) return event.replace(m[1], () => JSON.stringify(d));
        } catch { /* not JSON, pass through */ }
        return event;
    }

    _flush(cb) {
        if (this._buf.trim()) this.push(this._fix(this._buf) + '\n\n');
        if (this._onUsage) this._onUsage(this._inputTokens, this._outputTokens);
        cb();
    }
}

/**
 * For non-streaming JSON responses, ensure `usage` exists.
 */
function normalizeJsonBody(buf) {
    try {
        const obj = JSON.parse(buf);
        if (obj.type === 'message' && !obj.usage) {
            obj.usage = { input_tokens: 0, output_tokens: 0 };
        }
        stripRedactedThinking(obj);
        return Buffer.from(JSON.stringify(obj));
    } catch { /* not JSON */ }
    return buf;
}

function stripAllThinkingBlocks(body) {
    if (!body?.messages) return;
    for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter(b => b.type !== 'thinking');
    }
}

function stripUnsignedThinkingBlocks(body) {
    if (!body?.messages) return;
    for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter(
            block => block.type !== 'thinking' || block.signature
        );
    }
}

/**
 * Detect title-generation requests: very low max_tokens, no tools,
 * system message asking for a title. Mock locally to save an API call.
 */
function isTitleGenRequest(parsed) {
    if (!parsed || !parsed.messages) return false;
    if ((parsed.max_tokens || 0) > 256) return false;
    if (parsed.tools?.length) return false;
    const text = JSON.stringify(parsed.messages).toLowerCase();
    return text.includes('title') || text.includes('summariz') || text.includes('short');
}

function makeTitleGenResponse() {
    return {
        id: 'msg_title_mock',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Coding session' }],
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
    };
}

/**
 * Strip redacted_thinking blocks that OpenRouter emits out-of-order
 * for non-Claude reasoning models. These break the SSE parser.
 */
function stripRedactedThinking(parsed) {
    if (!parsed?.content) return;
    if (!Array.isArray(parsed.content)) return;
    parsed.content = parsed.content.filter(
        block => block.type !== 'redacted_thinking'
    );
}

// Recurses into tool_result.content[] because Claude Code's Read tool
// wraps a returned PNG there rather than at the top of the message.
function containsImageBlock(messages) {
    if (!Array.isArray(messages)) return false;
    const blockHasImage = (block) => {
        if (!block) return false;
        if (block.type === 'image') return true;
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
            return block.content.some(blockHasImage);
        }
        return false;
    };
    for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue;
        if (msg.content.some(blockHasImage)) return true;
    }
    return false;
}

// Replaces image blocks with a text placeholder, recursing into
// tool_result.content[]. Used on non-Anthropic routes so a single image
// turn earlier in history doesn't pin the rest of the conversation to
// Anthropic — which would silently spend Max quota while the TUI still
// shows the cheap backend. Returns the count of images replaced.
function stripImagesFromMessages(messages) {
    if (!Array.isArray(messages)) return 0;
    let count = 0;
    const strip = (block) => {
        if (!block) return block;
        if (block.type === 'image') {
            count++;
            return { type: 'text', text: '[image omitted]' };
        }
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
            return { ...block, content: block.content.map(strip) };
        }
        return block;
    };
    for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue;
        msg.content = msg.content.map(strip);
    }
    return count;
}

// --- Gemini direct vision fallback ---
// Translates the latest user turn to Gemini API format, sends it,
// and translates the response back to Anthropic format so Claude Code
// sees a normal assistant reply.

function anthropicToGemini(parsed) {
    const sysText = Array.isArray(parsed.system)
        ? parsed.system.map(s => s.text || s.content || '').filter(Boolean).join('\n\n')
        : (typeof parsed.system === 'string' ? parsed.system : '');

    const contents = [];
    for (const msg of parsed.messages || []) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const parts = [];
        const content = Array.isArray(msg.content) ? msg.content : [msg.content];
        for (const block of content) {
            if (!block) continue;
            if (block.type === 'text') {
                parts.push({ text: block.text || '' });
            } else if (block.type === 'image') {
                const src = block.source || block.image_url || {};
                const b64 = src.data || '';
                const mime = src.media_type || src.format || 'image/png';
                parts.push({ inline_data: { mime_type: mime, data: b64 } });
            } else if (block.type === 'tool_result') {
                const inner = Array.isArray(block.content) ? block.content : [block.content];
                let txt = '';
                for (const b of inner) {
                    if (b && b.type === 'text') txt += (txt ? '\n' : '') + (b.text || '');
                }
                parts.push({ text: txt || '[tool result]' });
            } else if (block.type === 'tool_use') {
                parts.push({ text: JSON.stringify({ tool: block.name, id: block.id, input: block.input }) });
            } else if (typeof block === 'string') {
                parts.push({ text: block });
            }
        }
        if (parts.length) contents.push({ role, parts });
    }

    const generationConfig = { max_output_tokens: parsed.max_tokens || 4096 };
    if (parsed.temperature != null) generationConfig.temperature = parsed.temperature;

    const geminiReq = { contents, generationConfig };
    if (sysText) geminiReq.system_instruction = { parts: [{ text: sysText }] };

    return geminiReq;
}

function geminiToAnthropic(geminiResp, originalModel) {
    const candidate = geminiResp.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
    const finishReason = candidate?.finish_reason;
    const stopReason = finishReason === 'STOP' ? 'end_turn'
        : finishReason === 'MAX_TOKENS' ? 'max_tokens'
        : finishReason === 'SAFETY' ? 'end_turn'
        : 'end_turn';

    const usageMeta = geminiResp.usage_metadata || {};
    return {
        id: 'msg_gemini_' + Date.now(),
        type: 'message',
        role: 'assistant',
        model: originalModel || GEMINI_MODEL,
        content: [{ type: 'text', text }],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: usageMeta.prompt_token_count || 0,
            output_tokens: usageMeta.candidates_token_count || 0,
        },
    };
}

function sendGeminiRequest(geminiReq, callback) {
    const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent`;
    const parsedUrl = new URL(url);
    const body = JSON.stringify(geminiReq);

    const opts = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
            'content-length': Buffer.byteLength(body),
        },
    };

    const req = httpsRequest(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                callback(null, parsed, res.statusCode);
            } catch (e) {
                callback(e, null, res.statusCode);
            }
        });
    });
    req.on('error', (e) => callback(e));
    req.write(body);
    req.end();
}

// ---

export function startModelProxy({ targetUrl, apiKey, startPort = 3200, backends, defaultMode }) {
    return new Promise((resolve, reject) => {
        const initialTarget = new URL(targetUrl);
        const initialBearer = targetUrl.includes('openrouter') || targetUrl.includes('fireworks');

        const allBackends = {};
        if (backends) {
            for (const [name, cfg] of Object.entries(backends)) {
                allBackends[name] = {
                    target: new URL(cfg.url),
                    apiKey: cfg.apiKey,
                    useBearer: cfg.url.includes('openrouter') || cfg.url.includes('fireworks'),
                };
            }
        }
        const initialName = defaultMode || (backends ? 'anthropic' : null);
        const startBackend = initialName && initialName !== 'anthropic' && allBackends[initialName];

        const state = {
            mode: initialName || '_single',
            target: startBackend ? startBackend.target : initialTarget,
            apiKey: startBackend ? startBackend.apiKey : apiKey,
            useBearer: startBackend ? startBackend.useBearer : initialBearer,
            hadNonAnthropicSession: !!startBackend,
        };

        let reqCount = 0;
        const t0Global = Date.now();
        const costs = {};

        function recordUsage(backend, inputTokens, outputTokens) {
            if (!costs[backend]) costs[backend] = { input: 0, output: 0, requests: 0 };
            costs[backend].input += inputTokens || 0;
            costs[backend].output += outputTokens || 0;
            costs[backend].requests++;
        }

        function getCostSummary() {
            const summary = {};
            let totalActual = 0;
            let totalAnthropic = 0;
            for (const [backend, tokens] of Object.entries(costs)) {
                const p = PRICING_PER_M[backend] || PRICING_PER_M._single;
                const ap = PRICING_PER_M.anthropic;
                const actual = (tokens.input * p.input + tokens.output * p.output) / 1_000_000;
                const anthropicEq = (tokens.input * ap.input + tokens.output * ap.output) / 1_000_000;
                totalActual += actual;
                totalAnthropic += anthropicEq;
                summary[backend] = {
                    input_tokens: tokens.input,
                    output_tokens: tokens.output,
                    requests: tokens.requests,
                    cost: +actual.toFixed(4),
                    anthropic_equivalent: +anthropicEq.toFixed(4),
                };
            }
            return {
                backends: summary,
                total_cost: +totalActual.toFixed(4),
                anthropic_equivalent: +totalAnthropic.toFixed(4),
                savings: +((totalAnthropic - totalActual).toFixed(4)),
            };
        }

        function switchMode(name) {
            if (name === 'anthropic') {
                const prev = state.mode;
                state.mode = 'anthropic';
                state.target = new URL(ANTHROPIC_FALLBACK);
                state.apiKey = null;
                state.useBearer = false;
                return { mode: 'anthropic', previous: prev };
            }
            const b = allBackends[name];
            if (!b) return { error: `Unknown backend: ${name}. Valid: anthropic, ${Object.keys(allBackends).join(', ')}` };
            if (!b.apiKey) return { error: `API key not set for ${name}` };
            const prev = state.mode;
            state.mode = name;
            state.target = b.target;
            state.apiKey = b.apiKey;
            state.useBearer = b.useBearer;
            state.hadNonAnthropicSession = true;
            return { mode: name, previous: prev };
        }

        const server = createServer((clientReq, clientRes) => {
            const urlPath = clientReq.url.split('?')[0];

            // Control endpoints — /_proxy/* (never collides with /v1/*)
            if (urlPath.startsWith('/_proxy/')) {
                if (urlPath === '/_proxy/status') {
                    clientRes.writeHead(200, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({
                        mode: state.mode,
                        uptime: Math.round((Date.now() - t0Global) / 1000),
                        requests: reqCount,
                    }));
                    return;
                }
                if (urlPath === '/_proxy/cost') {
                    clientRes.writeHead(200, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify(getCostSummary()));
                    return;
                }
                if (urlPath === '/_proxy/mode' && clientReq.method === 'POST') {
                    const origin = clientReq.headers['origin'] || '';
                    if (origin && !origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
                        clientRes.writeHead(403, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ error: 'Forbidden' }));
                        return;
                    }
                    const chunks = [];
                    let bodySize = 0;
                    clientReq.on('data', c => {
                        bodySize += c.length;
                        if (bodySize > 1024) { clientReq.destroy(); return; }
                        chunks.push(c);
                    });
                    clientReq.on('end', () => {
                        const body = Buffer.concat(chunks).toString();
                        const m = body.match(/backend=([a-z]+)/);
                        if (!m) {
                            clientRes.writeHead(400, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify({ error: 'Missing backend= in body' }));
                            return;
                        }
                        const result = switchMode(m[1]);
                        if (result.error) {
                            clientRes.writeHead(400, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify(result));
                            return;
                        }
                        console.error(`[MODEL-PROXY] Mode switched: ${result.previous} → ${result.mode}`);
                        clientRes.writeHead(200, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify(result));
                    });
                    return;
                }
                if (urlPath === '/_proxy/mode' && clientReq.method !== 'POST') {
                    clientRes.writeHead(405, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({ error: 'Use POST' }));
                    return;
                }
                clientRes.writeHead(404, { 'content-type': 'application/json' });
                clientRes.end(JSON.stringify({ error: 'Not found' }));
                return;
            }

            // Count tokens mock — answer locally instead of forwarding to
            // backends that lack this endpoint. Approximate: ~4 chars per token
            // for English text, which is conservative but avoids upstream 404s.
            if (urlPath === '/v1/messages/count_tokens' && clientReq.method === 'POST') {
                const chunks = [];
                clientReq.on('data', c => chunks.push(c));
                clientReq.on('end', () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString());
                        const text = JSON.stringify(body.messages || body);
                        const approx = Math.ceil(text.length / 4);
                        clientRes.writeHead(200, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ input_tokens: approx }));
                    } catch {
                        clientRes.writeHead(200, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ input_tokens: 0 }));
                    }
                });
                return;
            }

            // Routing is deferred to the end-of-body handler so the body
            // can be inspected for image content blocks before the
            // dest/headers are decided.
            const reqId = ++reqCount;
            const t0 = Date.now();

            const chunks = [];
            let bodySize = 0;
            clientReq.on('data', c => {
                bodySize += c.length;
                if (bodySize > MAX_BODY_SIZE) {
                    console.error(`[MODEL-PROXY] #${reqId} BODY_TOO_LARGE (${bodySize} bytes)`);
                    clientRes.writeHead(413, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({ error: { message: 'Request body too large' } }));
                    clientReq.destroy();
                    return;
                }
                chunks.push(c);
            });
            clientReq.on('end', () => {
                if (bodySize > MAX_BODY_SIZE) return;
                let body = Buffer.concat(chunks);
                const isMessagesPath = MODEL_PATHS.includes(urlPath);

                let parsed = null;
                if (isMessagesPath) {
                    try { parsed = JSON.parse(body); } catch {}
                }

                // --- Image fallback detection ---
                // Only the latest message triggers the reroute (a fresh
                // attachment or a Read tool_result that just came back).
                // Stale images in older history are stripped below so the
                // conversation can return to the backend on text-only
                // follow-ups instead of silently pinning to the fallback.
                const lastMsg = parsed?.messages?.[parsed.messages.length - 1];
                const hasImage = (
                    IMAGE_FALLBACK_ENABLED &&
                    state.mode !== 'anthropic' &&
                    !!lastMsg &&
                    containsImageBlock([lastMsg])
                );

                const isAnthropicMode = state.mode === 'anthropic';
                const isModelCall = !isAnthropicMode && isMessagesPath;

                // When routing image to fallback provider, swap model names
                // on the wire so the provider sees a model it recognizes,
                // then swap back on the response so Claude Code doesn't notice.
                let imageRewrite = null;
                let effectiveMode = state.mode;
                let dest, fullPath, headers;

                if (hasImage) {
                    if (IMAGE_FALLBACK === 'openrouter') {
                        // Route image to OpenRouter with a vision-capable model
                        const orKey = process.env.OPENROUTER_API_KEY;
                        if (!orKey) {
                            console.error(`[MODEL-PROXY] #${reqId} image fallback: OPENROUTER_API_KEY not set, using Anthropic`);
                            dest = new URL(ANTHROPIC_FALLBACK);
                            headers = { ...clientReq.headers, host: dest.host };
                            delete headers['content-length'];
                            effectiveMode = 'anthropic_max';
                        } else {
                            dest = new URL('https://openrouter.ai/api/v1');
                            headers = { ...clientReq.headers, host: dest.host };
                            delete headers['content-length'];
                            delete headers['authorization'];
                            delete headers['x-api-key'];
                            headers['authorization'] = `Bearer ${orKey}`;
                            if (parsed?.model) {
                                imageRewrite = { backend: parsed.model, canonical: IMAGE_FALLBACK_MODEL };
                                parsed.model = IMAGE_FALLBACK_MODEL;
                            }
                            effectiveMode = 'image_fallback';
                        }
                    } else if (IMAGE_FALLBACK === 'gemini') {
                        // Route image to Gemini directly via Google AI Studio
                        if (!GEMINI_API_KEY) {
                            console.error(`[MODEL-PROXY] #${reqId} image fallback: GEMINI_API_KEY not set, using Anthropic`);
                            dest = new URL(ANTHROPIC_FALLBACK);
                            headers = { ...clientReq.headers, host: dest.host };
                            delete headers['content-length'];
                            effectiveMode = 'anthropic_max';
                        } else {
                            console.error(`[MODEL-PROXY] #${reqId} [image→gemini ${GEMINI_MODEL}]`);
                            const geminiReq = anthropicToGemini(parsed);
                            sendGeminiRequest(geminiReq, (err, geminiResp, status) => {
                                if (err) {
                                    console.error(`[MODEL-PROXY] #${reqId} Gemini error:`, err.message);
                                    clientRes.writeHead(502, { 'content-type': 'application/json' });
                                    clientRes.end(JSON.stringify({ error: { message: 'Gemini vision request failed: ' + err.message } }));
                                    return;
                                }
                                if (status !== 200 || !geminiResp?.candidates?.length) {
                                    const errText = geminiResp?.error?.message || `HTTP ${status}`;
                                    console.error(`[MODEL-PROXY] #${reqId} Gemini API error: ${errText}`);
                                    clientRes.writeHead(502, { 'content-type': 'application/json' });
                                    clientRes.end(JSON.stringify({ error: { message: 'Gemini vision error: ' + errText } }));
                                    return;
                                }
                                const anthropicResp = geminiToAnthropic(geminiResp, parsed.model);
                                // Track usage for cost calculation
                                const usage = anthropicResp.usage || {};
                                recordUsage('gemini', usage.input_tokens || 0, usage.output_tokens || 0);
                                console.error(`[MODEL-PROXY] #${reqId} Gemini done in ${((Date.now() - t0) / 1000).toFixed(1)}s (in=${usage.input_tokens} out=${usage.output_tokens})`);
                                clientRes.writeHead(200, { 'content-type': 'application/json' });
                                clientRes.end(JSON.stringify(anthropicResp));
                            });
                            return; // Async — skip normal proxy flow
                        }
                    } else {
                        // IMAGE_FALLBACK === 'anthropic' (default): route
                        // to api.anthropic.com using existing Claude Code auth
                        dest = new URL(ANTHROPIC_FALLBACK);
                        headers = { ...clientReq.headers, host: dest.host };
                        delete headers['content-length'];
                        effectiveMode = 'anthropic_max';
                    }

                    // Swap model to canonical Claude name for Anthropic
                    if (effectiveMode === 'anthropic_max' && parsed?.model) {
                        const canonical = REVERSE_MODEL_REMAP[state.mode]?.[parsed.model];
                        if (canonical) {
                            imageRewrite = { backend: parsed.model, canonical };
                            parsed.model = canonical;
                        }
                    }

                    // Drop thinking config on image reroute — Anthropic 400s
                    // with clear_thinking strategies if thinking isn't enabled.
                    delete parsed.thinking;
                    delete parsed.context_management;

                    body = Buffer.from(JSON.stringify(parsed));
                    fullPath = '/v1/messages';
                    console.error(`[MODEL-PROXY] #${reqId} [image→${effectiveMode}${imageRewrite ? `, ${imageRewrite.backend}→${imageRewrite.canonical}` : ''}]`);
                } else {
                    // Normal routing
                    dest = isModelCall ? state.target : new URL(ANTHROPIC_FALLBACK);

                    let fullPathBase;
                    if (isModelCall) {
                        const base = state.target.pathname.replace(/\/$/, '');
                        let overlap = '';
                        for (let i = 1; i <= Math.min(base.length, urlPath.length); i++) {
                            if (base.endsWith(urlPath.substring(0, i))) overlap = urlPath.substring(0, i);
                        }
                        fullPathBase = overlap ? base + urlPath.substring(overlap.length) : base + urlPath;
                    } else {
                        fullPathBase = clientReq.url;
                    }
                    fullPath = fullPathBase;

                    headers = { ...clientReq.headers, host: dest.host };
                    delete headers['content-length'];

                    if (isModelCall) {
                        delete headers['authorization'];
                        delete headers['x-api-key'];
                        if (state.useBearer) {
                            headers['authorization'] = `Bearer ${state.apiKey}`;
                        } else {
                            headers['x-api-key'] = state.apiKey;
                        }
                    }

                    // Strip stale images from message history so a single
                    // image turn doesn't pin the rest of the conversation to
                    // the fallback provider.
                    if (isModelCall && parsed?.['messages']) {
                        const stripped = stripImagesFromMessages(parsed.messages);
                        if (stripped > 0) {
                            console.error(`[MODEL-PROXY] #${reqId} stripped ${stripped} stale image(s) from history`);
                            body = Buffer.from(JSON.stringify(parsed));
                        }
                    }
                }

                const trackUsage = isModelCall || hasImage;
                if (trackUsage) {
                    console.error(`[MODEL-PROXY] #${reqId} → ${dest.hostname}${fullPath}`);
                }

                // Telemetry mock: intercept title-generation
                if (trackUsage) {
                    try {
                        const p = JSON.parse(body);
                        if (isTitleGenRequest(p)) {
                            console.error(`[MODEL-PROXY] #${reqId} title-gen mocked (saved 1 round-trip)`);
                            const mockResp = makeTitleGenResponse();
                            clientRes.writeHead(200, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify(mockResp));
                            return;
                        }
                    } catch { /* pass through */ }
                }

                // Remap Anthropic model names to backend-specific names
                if (isModelCall && MODEL_REMAP[state.mode]) {
                    try {
                        const p = JSON.parse(body);
                        const remap = MODEL_REMAP[state.mode];
                        let mapped = remap[p.model];
                        if (!mapped) {
                            const tier = p.model.includes('fable') ? 'fable'
                                : p.model.includes('opus') ? 'opus'
                                : p.model.includes('sonnet') ? 'sonnet'
                                : p.model.includes('haiku') ? 'haiku'
                                : null;
                            if (remap._default && tier) {
                                mapped = remap._default[tier];
                                console.error(`[MODEL-PROXY] #${reqId} model fallback: ${p.model} → ${mapped} (tier=${tier})`);
                            } else {
                                console.error(`[MODEL-PROXY] #${reqId} WARNING: unmapped model ${p.model} forwarded raw`);
                            }
                        } else {
                            console.error(`[MODEL-PROXY] #${reqId} model remap: ${p.model} → ${mapped}`);
                        }
                        if (mapped) {
                            p.model = mapped;
                            body = Buffer.from(JSON.stringify(p));
                        }
                    } catch { /* pass through */ }
                }

                // Strip thinking blocks before forwarding
                if (isAnthropicMode && isMessagesPath && !hasImage) {
                    try {
                        const p = JSON.parse(body);
                        if (state.hadNonAnthropicSession) {
                            stripAllThinkingBlocks(p);
                        } else {
                            stripUnsignedThinkingBlocks(p);
                        }
                        body = Buffer.from(JSON.stringify(p));
                    } catch { /* pass through */ }
                }
                if (isModelCall) {
                    try {
                        const p = JSON.parse(body);
                        delete p.thinking;
                        delete p.context_management;
                        body = Buffer.from(JSON.stringify(p));
                    } catch { /* pass through */ }
                }

                // Strip accept-encoding when the body was mutated (image
                // fallback swaps model names in the response), otherwise
                // the upstream may gzip and we can't rewrite.
                const finalHeaders = { ...headers, 'content-length': body.length };
                if (hasImage) {
                    delete finalHeaders['accept-encoding'];
                }

                const opts = {
                    hostname: dest.hostname,
                    port: dest.port || 443,
                    path: fullPath,
                    method: clientReq.method,
                    headers: finalHeaders,
                    timeout: REQUEST_TIMEOUT_MS,
                };

                const proxyReq = httpsRequest(opts, (proxyRes) => {
                    if (trackUsage) {
                        const ttfb = Date.now() - t0;
                        console.error(`[MODEL-PROXY] #${reqId} TTFB ${ttfb}ms (status ${proxyRes.statusCode})`);
                    }

                    const ct = proxyRes.headers['content-type'] || '';
                    const isSSE = ct.includes('text/event-stream');

                    // Without this, an upstream stream error (connection reset
                    // mid-response) emits an unhandled 'error' on proxyRes and
                    // crashes the proxy process.
                    proxyRes.on('error', (err) => {
                        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                        console.error(`[MODEL-PROXY] #${reqId} upstream stream error after ${elapsed}s: ${err.message}`);
                        if (!clientRes.headersSent) {
                            clientRes.writeHead(502, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify({ error: { message: 'Upstream stream error' } }));
                        } else {
                            clientRes.destroy(err);
                        }
                    });

                    if (trackUsage && isSSE) {
                        // Strip content-encoding when body is mutated
                        // (image fallback rewrites model names in-stream).
                        const sseHeaders = hasImage
                            ? (() => { const { 'content-encoding': _ce, ...h } = proxyRes.headers; return h; })()
                            : proxyRes.headers;
                        clientRes.writeHead(proxyRes.statusCode, sseHeaders);
                        const modelRewrite = imageRewrite
                            ? { from: imageRewrite.canonical, to: imageRewrite.backend }
                            : null;
                        const norm = new UsageNormalizer(
                            (inp, out) => recordUsage(effectiveMode, inp, out),
                            { modelRewrite },
                        );
                        proxyRes.pipe(norm).pipe(clientRes);
                        proxyRes.on('end', () => {
                            console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${norm._inputTokens}in/${norm._outputTokens}out)`);
                        });
                    } else if (trackUsage && ct.includes('application/json')) {
                        const respChunks = [];
                        proxyRes.on('data', c => respChunks.push(c));
                        proxyRes.on('end', () => {
                            const raw = Buffer.concat(respChunks);
                            let fixed = normalizeJsonBody(raw);
                            try {
                                const j = JSON.parse(fixed);
                                if (j.usage) recordUsage(effectiveMode, j.usage.input_tokens, j.usage.output_tokens);
                                if (imageRewrite && j.model === imageRewrite.canonical) {
                                    j.model = imageRewrite.backend;
                                    fixed = Buffer.from(JSON.stringify(j));
                                }
                            } catch {}
                            const jsonHeaders = hasImage
                                ? (() => { const { 'content-encoding': _ce2, ...h } = proxyRes.headers; return h; })()
                                : proxyRes.headers;
                            const outHeaders = { ...jsonHeaders, 'content-length': fixed.length };
                            clientRes.writeHead(proxyRes.statusCode, outHeaders);
                            clientRes.end(fixed);
                            console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (json, ${fixed.length}b)`);
                        });
                    } else {
                        // Non-model or unknown content-type: pass through
                        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                        proxyRes.pipe(clientRes);
                        if (trackUsage) {
                            proxyRes.on('end', () => {
                                console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
                            });
                        }
                    }
                });

                proxyReq.on('timeout', () => {
                    console.error(`[MODEL-PROXY] #${reqId} TIMEOUT after ${REQUEST_TIMEOUT_MS / 1000}s`);
                    proxyReq.destroy(new Error('Request timeout'));
                });

                proxyReq.on('error', (err) => {
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                    console.error(`[MODEL-PROXY] #${reqId} ERROR after ${elapsed}s: ${err.message}`);
                    if (!clientRes.headersSent) {
                        clientRes.writeHead(502, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ error: { message: 'Upstream connection error' } }));
                    } else {
                        // Headers already sent (likely mid-SSE) — emitting JSON
                        // here would inject a non-event into the event-stream and
                        // break the client parser. Terminate the response so the
                        // client sees a clean transport error instead.
                        clientRes.destroy(err);
                    }
                });

                proxyReq.end(body);
            });
        });

        function tryListen(port) {
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE' && port < startPort + 20) {
                    tryListen(port + 1);
                } else {
                    reject(err);
                }
            });
            server.listen(port, '127.0.0.1', () => {
                const actualPort = server.address().port;
                console.error(`[MODEL-PROXY] Listening on 127.0.0.1:${actualPort} → ${targetUrl} (mode: ${state.mode})`);
                resolve({ port: actualPort, close: () => server.close(), switchMode });
            });
        }

        tryListen(startPort);
    });
}
