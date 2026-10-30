import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { Transform } from 'stream';
import { StringDecoder } from 'node:string_decoder';

const ANTHROPIC_FALLBACK = 'https://api.anthropic.com';
const MODEL_PATHS = ['/v1/messages'];
// DeepSeek rejects request bodies above 48 MiB. Enforce the same limit
// locally so callers receive a clear 413 instead of an upstream failure.
const MAX_BODY_SIZE = 48 * 1024 * 1024;
// A Files upload permits a 64 MiB file plus multipart envelope. The upstream
// validates the actual file size; Messages retain their separate 48 MiB cap.
const MAX_FILES_BODY_SIZE = 65 * 1024 * 1024;
const FILES_BETA = 'files-api-2025-04-14';

function withFilesBeta(value) {
    return [...new Set([...(value || '').split(',').map(v => v.trim()).filter(Boolean), FILES_BETA])].join(',');
}
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per request
const DEFAULT_SEMANTIC_STALL_TIMEOUT_MS = 2 * 60 * 1000;
export const DEEPSEEK_VISION_MODEL = process.env.DEEPCLAUDE_VISION_MODEL
    || 'deepseek-flash';

function semanticStallTimeoutFromEnv() {
    const raw = process.env.DEEPCLAUDE_SEMANTIC_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_SEMANTIC_STALL_TIMEOUT_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0
        ? parsed
        : DEFAULT_SEMANTIC_STALL_TIMEOUT_MS;
}

const MODEL_REMAP = {
    deepseek: {
        _default: { fable: 'deepseek-flash', opus: 'deepseek-flash', sonnet: 'deepseek-flash', haiku: 'deepseek-flash' },
        'claude-fable-5':     'deepseek-flash',
        'claude-opus-5':      'deepseek-flash',
        'claude-opus-4-6':    'deepseek-flash',
        'claude-opus-4-7':    'deepseek-flash',
        'claude-opus-4-8':    'deepseek-flash',
        'claude-sonnet-5':    'deepseek-flash',
        'claude-sonnet-4-6':  'deepseek-flash',
        'claude-sonnet-4-5-20250929': 'deepseek-flash',
        'claude-haiku-4-5-20251001':  'deepseek-flash',
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
    minimax: {
        _default: { fable: 'minimax/minimax-m3:free', opus: 'minimax/minimax-m3:free', sonnet: 'minimax/minimax-m3:free', haiku: 'minimax/minimax-m3:free' },
        'claude-fable-5':     'minimax/minimax-m3:free',
        'claude-opus-5':      'minimax/minimax-m3:free',
        'claude-opus-4-6':    'minimax/minimax-m3:free',
        'claude-opus-4-7':    'minimax/minimax-m3:free',
        'claude-opus-4-8':    'minimax/minimax-m3:free',
        'claude-sonnet-5':    'minimax/minimax-m3:free',
        'claude-sonnet-4-6':  'minimax/minimax-m3:free',
        'claude-sonnet-4-5-20250929': 'minimax/minimax-m3:free',
        'claude-haiku-4-5-20251001':  'minimax/minimax-m3:free',
    },
};

const PRICING_PER_M = {
    deepseek:       { input: 0.30,  output: 1.20, cacheRead: 0.006 },
    openrouter:     { input: 0.44,  output: 0.87 },
    minimax:        { input: 0,     output: 0 },
    fireworks:      { input: 1.74,  output: 3.48 },
    anthropic:      { input: 3.00,  output: 15.00 },
    // Flash peak prices: conservative estimate, not an invoice. Off-peak and
    // Chinese public holidays can lower actual billing; search/fetch is extra.
    deepseek_vision:{ input: 0.30,  output: 1.20, cacheRead: 0.006 },
    _single:        { input: 0.44,  output: 0.87 },
};

/**
 * Transform stream that intercepts SSE events and injects missing `usage`
 * fields. DeepSeek/OpenRouter may omit `usage` in message_start or
 * message_delta, which crashes Claude Code ("$.input_tokens" is undefined).
 */
class UsageNormalizer extends Transform {
    constructor(onUsage, { modelRewrite, onSemanticEvent, onParseError } = {}) {
        super();
        this._buf = '';
        this._decoder = new StringDecoder('utf8');
        this._onUsage = onUsage;
        this._inputTokens = 0;
        this._outputTokens = 0;
        // Context-telemetry fields (metadata only, no content retained).
        this._respBytes = 0;
        this._sawInputUsage = false;
        this._sawOutputUsage = false;
        this._cacheRead = null;
        this._cacheCreation = null;
        // Response-shape accumulator: block types, tool names, protocol
        // markers only — never text, arguments, or results.
        this._respMeta = {
            blockTypes: [],
            toolUseNames: [],
            serverToolUseNames: [],
            toolSearchResultCount: 0,
            toolReferenceCount: 0,
            stopReason: null,
        };
        this._modelRewrite = modelRewrite || null;
        this._onSemanticEvent = onSemanticEvent || null;
        this._onParseError = onParseError || null;
    }

    _transform(chunk, _enc, cb) {
        this._respBytes += chunk.length;
        this._buf += this._decoder.write(chunk);
        const parts = this._buf.split(/\r?\n\r?\n/);
        this._buf = parts.pop();
        for (const part of parts) {
            this.push(this._fix(part) + '\n\n');
        }
        cb();
    }

    _fix(event) {
        const m = event.match(/^data: (.+)$/m);
        if (!m) return event;
        if (m[1].trim() === '[DONE]') return event;
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
                    this._sawInputUsage = true;
                    if (Number.isFinite(d.message.usage.cache_read_input_tokens)) {
                        this._cacheRead = d.message.usage.cache_read_input_tokens;
                    }
                    if (Number.isFinite(d.message.usage.cache_creation_input_tokens)) {
                        this._cacheCreation = d.message.usage.cache_creation_input_tokens;
                    }
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
                    if (Number.isFinite(d.usage.input_tokens)) {
                        this._inputTokens = d.usage.input_tokens;
                        this._sawInputUsage = true;
                    }
                    if (Number.isFinite(d.usage.output_tokens)) {
                        this._outputTokens = d.usage.output_tokens;
                        this._sawOutputUsage = true;
                    }
                    if (Number.isFinite(d.usage.cache_read_input_tokens)) {
                        this._cacheRead = d.usage.cache_read_input_tokens;
                    }
                    if (Number.isFinite(d.usage.cache_creation_input_tokens)) {
                        this._cacheCreation = d.usage.cache_creation_input_tokens;
                    }
                } else {
                    d.usage = { output_tokens: 0 };
                    changed = true;
                }
                const stop = sanitizeToken(d.delta?.stop_reason ?? d.stop_reason);
                if (stop) this._respMeta.stopReason = stop;
            }
            if (d.type === 'content_block_start' && d.content_block) {
                const t = sanitizeToken(d.content_block.type);
                if (t) {
                    if (this._respMeta.blockTypes.length < 64) this._respMeta.blockTypes.push(t);
                    if (t === 'tool_use') {
                        const n = sanitizeToken(d.content_block.name);
                        if (n && this._respMeta.toolUseNames.length < 32) this._respMeta.toolUseNames.push(n);
                    } else if (t === 'server_tool_use') {
                        const n = sanitizeToken(d.content_block.name);
                        if (n && this._respMeta.serverToolUseNames.length < 32) {
                            this._respMeta.serverToolUseNames.push(n);
                        }
                    } else if (t === 'tool_search_tool_result') {
                        this._respMeta.toolSearchResultCount++;
                    } else if (t === 'tool_reference') {
                        this._respMeta.toolReferenceCount++;
                    }
                }
            }
            if (this._onSemanticEvent) {
                queueMicrotask(() => this._onSemanticEvent(d));
            }
            if (changed) return event.replace(m[1], () => JSON.stringify(d));
        } catch (err) {
            this._onParseError?.(err, event.length);
        }
        return event;
    }

    _flush(cb) {
        this._buf += this._decoder.end();
        if (this._buf.trim()) this.push(this._fix(this._buf) + '\n\n');
        if (this._onUsage) this._onUsage(this._inputTokens, this._outputTokens, this._cacheRead, this._cacheCreation);
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
export function containsImageBlock(messages) {
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
export function stripImagesFromMessages(messages) {
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

const IMAGE_MEDIA_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
]);

function imageBlocksIn(block) {
    if (!block) return [];
    if (block.type === 'image') return [block];
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return block.content.flatMap(imageBlocksIn);
    }
    return [];
}

function imageBytesMatchMediaType(bytes, mediaType) {
    if (mediaType === 'image/png') {
        return bytes.length >= 8
            && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (mediaType === 'image/jpeg') {
        return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (mediaType === 'image/gif') {
        return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    }
    if (mediaType === 'image/webp') {
        return bytes.length >= 12
            && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
            && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    }
    return false;
}

function validateDeepSeekImages(messages) {
    let imageCount = 0;
    for (const message of messages || []) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content.flatMap(imageBlocksIn)) {
            if (++imageCount > 600) return 'DeepSeek allows at most 600 images per request';
            const source = block.source;
            if (!source || !source.type) return 'image block is missing its source';
            if (source.type === 'base64') {
                const mediaType = source.media_type?.toLowerCase();
                const data = typeof source.data === 'string' ? source.data.trim() : '';
                if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
                    return `unsupported image media_type ${source.media_type || '(missing)'}`;
                }
                const decodedSize = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
                if (decodedSize > 32 * 1024 * 1024) return 'Inline image exceeds DeepSeek limit of 32 MiB';
                if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
                    return 'invalid base64 data in image block';
                }
                const bytes = Buffer.from(data, 'base64');
                if (!bytes.length) return 'empty base64 data in image block';
                if (!imageBytesMatchMediaType(bytes, mediaType)) {
                    return `image bytes do not match media_type ${mediaType}`;
                }
                // Forward the same canonical values that were validated.
                source.media_type = mediaType;
                source.data = data;
            } else if (source.type === 'url') {
                if (typeof source.url !== 'string' || source.url.length > 8192) return 'Image URL exceeds 8192 characters or is missing';
                try {
                    const url = new URL(source.url);
                    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
                } catch {
                    return 'image URL must be a valid http(s) URL';
                }
            } else if (source.type === 'file') {
                if (typeof source.file_id !== 'string' || !/^file-api-[A-Za-z0-9_-]+$/.test(source.file_id)) {
                    return 'Image file source requires a DeepSeek file_id (file-api-...)';
                }
            } else {
                return `unsupported image source type ${source.type}`;
            }
        }
    }
    return null;
}

/**
 * Prepare a Claude Code Messages request for DeepSeek's native vision model.
 * DeepSeek accepts the Anthropic image block shape unchanged, so no content
 * translation is required. Only a user message may trigger vision routing.
 */
export function prepareDeepSeekVisionRequest(parsed) {
    const messages = parsed?.messages;
    const lastMessage = messages?.[messages.length - 1];
    if (lastMessage?.role !== 'user' || !containsImageBlock([lastMessage])) {
        return null;
    }

    // DeepSeek validates every image in the request. Keep the current image
    // turn, but replace older screenshots/read results with placeholders.
    if (messages.length > 1) stripImagesFromMessages(messages.slice(0, -1));
    const imageError = validateDeepSeekImages([lastMessage]);
    if (imageError) throw new Error(imageError);

    const originalModel = parsed.model;
    parsed.model = DEEPSEEK_VISION_MODEL;
    prepareBackendOptions(parsed, true);
    delete parsed.context_management;
    return { originalModel, visionModel: DEEPSEEK_VISION_MODEL };
}

// Preserve native server tools and reasoning history. Only direct DeepSeek
// accepts these reasoning controls under its current Anthropic contract.
export function prepareBackendOptions(parsed, isDeepSeek) {
    delete parsed.context_management;
    if (!isDeepSeek) {
        delete parsed.thinking;
        return;
    }
    if (parsed.thinking) {
        if (parsed.thinking.type === 'adaptive') parsed.thinking = { type: 'enabled' };
        else delete parsed.thinking.budget_tokens;
    }
    if (parsed.output_config) {
        const effort = parsed.output_config.effort;
        const mapped = { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max', ultra: 'max' }[effort];
        if (mapped) parsed.output_config = { effort: mapped };
        else delete parsed.output_config;
    }
}

// Approximation only, never a tokenizer. Include system and tool schemas, which
// the old messages-only estimate omitted. UTF-8 bytes also cover non-Latin text.
export function estimateInputTokens(parsed) {
    const input = { system: parsed.system, tools: parsed.tools, messages: parsed.messages };
    return Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / 3);
}

/**
 * Anthropic-compatible backends (DeepSeek, OpenRouter, ...) validate tool
 * `input_schema` with Python-style regex, which rejects the Unicode property
 * escapes (`\p{...}`) that Claude Code puts in `pattern` keywords — e.g. the
 * Artifact tool — returning 400 "not a regex". Anthropic tolerates them.
 * Strip `pattern`/`patternProperties` before forwarding so a strict validator
 * never sees them. Returns true when anything was removed.
 */
export function sanitizeToolSchemasForBackend(parsed) {
    let changed = false;
    const walk = (node) => {
        if (node === null || typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
            if (key === 'pattern' || key === 'patternProperties') {
                delete node[key];
                changed = true;
            } else if (node[key] !== null && typeof node[key] === 'object') {
                walk(node[key]);
            }
        }
    };
    const tools = parsed?.tools;
    if (Array.isArray(tools)) {
        for (const tool of tools) {
            if (tool && typeof tool?.input_schema === 'object') {
                walk(tool.input_schema);
            }
        }
    }
    return changed;
}

/**
 * Metadata-only context telemetry (Wave 1).
 *
 * These helpers compute per-request context metrics WITHOUT ever returning
 * prompt text, schemas, headers, keys, arguments, or results. All outputs are
 * counts, byte sizes, booleans, and the short model id string. They are pure:
 * they never mutate their input.
 */
export const CONTEXT_WARN_TOOLS_COUNT = 100;
export const CONTEXT_WARN_TOOLS_BYTES = 512 * 1024;

function jsonBytes(value, fallback = 0) {
    try {
        return Buffer.byteLength(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function sanitizeToken(value) {
    if (typeof value !== 'string' || !value) return null;
    const clean = value.replace(/[\r\n\t ]+/g, '_').slice(0, 120);
    return clean || null;
}

function sanitizeModelId(model) {
    return sanitizeToken(model) ?? '?';
}

export function computeContextMetrics(parsed, requestBytes) {
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];

    let imageCount = 0;
    let toolReferenceCountInMessages = 0;
    const scanBlock = (block) => {
        if (!block || typeof block !== 'object') return;
        if (block.type === 'image') imageCount++;
        if (block.type === 'tool_reference') toolReferenceCountInMessages++;
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
            for (const nested of block.content) scanBlock(nested);
        }
    };
    for (const msg of messages) {
        if (Array.isArray(msg?.content)) {
            for (const block of msg.content) scanBlock(block);
        }
    }

    // Deferred heuristic: a tool entry without a full `input_schema` object
    // (or explicitly flagged) is a deferred placeholder, not an expanded schema.
    let deferredToolsCount = 0;
    let nonDeferredToolsCount = 0;
    let hasToolSearchTool = false;
    for (const tool of tools) {
        if (tool && typeof tool === 'object' && tool.name === 'ToolSearch') {
            hasToolSearchTool = true;
        }
        if (tool && typeof tool === 'object'
            && (tool.deferred === true || tool.input_schema === undefined)) {
            deferredToolsCount++;
        } else {
            nonDeferredToolsCount++;
        }
    }

    return {
        model: sanitizeModelId(parsed?.model),
        requestBytes: Number.isFinite(requestBytes) ? requestBytes : -1,
        toolsCount: tools.length,
        toolsBytes: parsed && 'tools' in Object(parsed)
            ? jsonBytes(parsed.tools, -1)
            : 0,
        systemBytes: parsed && parsed.system !== undefined
            ? jsonBytes(parsed.system, -1)
            : 0,
        messagesBytes: parsed && 'messages' in Object(parsed)
            ? jsonBytes(parsed.messages, -1)
            : 0,
        imageCount,
        deferredToolsCount,
        nonDeferredToolsCount,
        hasToolSearchTool,
        toolReferenceCountInMessages,
    };
}

export function formatContextLine(reqId, mode, metrics) {
    const m = metrics;
    return `[context] req=${reqId} mode=${mode} model=${m.model} `
        + `tools=${m.toolsCount} tools_bytes=${m.toolsBytes} `
        + `request_bytes=${m.requestBytes} system_bytes=${m.systemBytes} `
        + `messages_bytes=${m.messagesBytes} images=${m.imageCount} `
        + `deferred=${m.deferredToolsCount} non_deferred=${m.nonDeferredToolsCount} `
        + `tool_search=${m.hasToolSearchTool} tool_refs=${m.toolReferenceCountInMessages}`;
}

export function needsContextWarning(metrics) {
    return metrics.toolsCount >= CONTEXT_WARN_TOOLS_COUNT
        || metrics.toolsBytes >= CONTEXT_WARN_TOOLS_BYTES;
}

export function formatContextWarning(reqId, mode, metrics) {
    return `[context-warning] LARGE TOOL CONTEXT req=${reqId} mode=${mode} `
        + `model=${metrics.model} tools=${metrics.toolsCount} `
        + `tools_bytes=${metrics.toolsBytes} request_bytes=${metrics.requestBytes}`;
}

/**
 * Pick known token-counter fields out of an upstream `usage` object.
 * Returns nulls (rendered as `na`) for absent fields — never fabricates zeros.
 */
export function extractUsageMetrics(usage) {
    if (!usage || typeof usage !== 'object') {
        return { inputTokens: null, outputTokens: null, cacheRead: null, cacheCreation: null };
    }
    const num = (v) => (Number.isFinite(v) ? v : null);
    return {
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
    };
}

function fmtTokens(v) {
    return v === null || v === undefined ? 'na' : String(v);
}

export function formatContextResponse(reqId, { status, responseBytes, inputTokens, outputTokens, cacheRead, cacheCreation, respMeta }) {
    const rm = respMeta || {};
    const blocks = Array.isArray(rm.blockTypes) && rm.blockTypes.length
        ? rm.blockTypes.slice(0, 32).join(',')
        : '-';
    const toolUses = Array.isArray(rm.toolUseNames) && rm.toolUseNames.length
        ? rm.toolUseNames.slice(0, 32).join(',')
        : '-';
    const serverTools = Array.isArray(rm.serverToolUseNames) && rm.serverToolUseNames.length
        ? rm.serverToolUseNames.slice(0, 32).join(',')
        : '-';
    return `[context-resp] req=${reqId} status=${status} resp_bytes=${responseBytes} `
        + `in=${fmtTokens(inputTokens)} out=${fmtTokens(outputTokens)} `
        + `cache_read=${fmtTokens(cacheRead)} cache_create=${fmtTokens(cacheCreation)} `
        + `blocks=${blocks} tool_uses=${toolUses} server_tools=${serverTools} `
        + `ts_results=${rm.toolSearchResultCount ?? 0} tool_refs=${rm.toolReferenceCount ?? 0} `
        + `stop=${rm.stopReason || '-'}`;
}

/**
 * Metadata-only response-shape summary. From an Anthropic message object
 * extracts block types, tool names, and protocol markers — never block text,
 * arguments, or results. Pure: never mutates input.
 */
export function computeResponseMetadata(message) {
    const meta = {
        blockTypes: [],
        toolUseNames: [],
        serverToolUseNames: [],
        toolSearchResultCount: 0,
        toolReferenceCount: 0,
        stopReason: sanitizeToken(message?.stop_reason),
    };
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const t = sanitizeToken(block.type);
        if (!t) continue;
        if (meta.blockTypes.length < 64) meta.blockTypes.push(t);
        if (t === 'tool_use') {
            const n = sanitizeToken(block.name);
            if (n && meta.toolUseNames.length < 32) meta.toolUseNames.push(n);
        } else if (t === 'server_tool_use') {
            const n = sanitizeToken(block.name);
            if (n && meta.serverToolUseNames.length < 32) meta.serverToolUseNames.push(n);
        } else if (t === 'tool_search_tool_result') {
            meta.toolSearchResultCount++;
        } else if (t === 'tool_reference') {
            meta.toolReferenceCount++;
        }
    }
    return meta;
}

/**
 * Graceful-shutdown signal wiring (Wave 2 fix).
 *
 * The launcher kills the proxy with SIGTERM the instant the client exits,
 * which used to drop in-flight upstream responses before their telemetry
 * flushed. Handlers are installed once per process; every live proxy
 * registers its shutdown routine. Semantics: stop accepting new work, let
 * in-flight upstream requests finish (bounded wait), then exit. No retries,
 * no payload changes.
 */
const proxyShutdownRegistry = new Set();
let proxySignalHandlersInstalled = false;

function installProxySignalHandlers() {
    if (proxySignalHandlersInstalled) return;
    proxySignalHandlersInstalled = true;
    const onSignal = (signal) => {
        console.error(`[MODEL-PROXY] ${signal} received, draining in-flight requests`);
        const pending = [...proxyShutdownRegistry].map((fn) => {
            try {
                return fn(2000);
            } catch {
                return Promise.resolve();
            }
        });
        Promise.allSettled(pending).then(() => process.exit(0));
        setTimeout(() => process.exit(0), 2500).unref?.();
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
}

export function buildUpstreamPath(target, requestPath) {
    const queryAt = requestPath.indexOf('?');
    const pathname = queryAt === -1 ? requestPath : requestPath.slice(0, queryAt);
    const query = queryAt === -1 ? '' : requestPath.slice(queryAt);
    const base = target.pathname.replace(/\/$/, '');
    let overlap = '';
    for (let i = 1; i <= Math.min(base.length, pathname.length); i++) {
        if (base.endsWith(pathname.substring(0, i))) {
            overlap = pathname.substring(0, i);
        }
    }
    const joined = overlap
        ? base + pathname.substring(overlap.length)
        : base + pathname;
    return joined + query;
}

export function startModelProxy({
    targetUrl,
    apiKey,
    startPort = 3200,
    backends,
    defaultMode,
    modelOverride = null,
    upstreamRequest = httpsRequest,
    terminalGraceMs = 5_000,
    semanticStallTimeoutMs = semanticStallTimeoutFromEnv(),
    mockTitleGeneration = process.env.DEEPCLAUDE_MOCK_TITLE_GEN === '1',
}) {
    return new Promise((resolve, reject) => {
        // Launchers pass short backend aliases; use canonical names for model
        // remapping, pricing, and reasoning controls as well as live switching.
        defaultMode = { ds: 'deepseek', or: 'openrouter', op: 'openrouter', mm: 'minimax', fw: 'fireworks' }[defaultMode] || defaultMode;
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
        const deepseekVisionBackend = allBackends.deepseek?.apiKey
            ? allBackends.deepseek
            : initialTarget.hostname.endsWith('deepseek.com') && apiKey
                ? { target: initialTarget, apiKey, useBearer: false }
                : null;
        const initialName = defaultMode || (backends ? 'anthropic' : null);
        const startBackend = initialName && initialName !== 'anthropic' && allBackends[initialName];

        const state = {
            mode: initialName || '_single',
            target: startBackend ? startBackend.target : initialTarget,
            apiKey: startBackend ? startBackend.apiKey : apiKey,
            useBearer: startBackend ? startBackend.useBearer : initialBearer,
            hadNonAnthropicSession: !!startBackend,
            modelOverride: defaultMode === 'openrouter' ? modelOverride : null,
        };

        let reqCount = 0;
        const t0Global = Date.now();
        const costs = {};
        // In-flight upstream request tracking for graceful shutdown.
        let inFlight = 0;

        function recordUsage(backend, inputTokens, outputTokens, cacheRead = 0, cacheCreation = 0) {
            if (!costs[backend]) costs[backend] = { input: 0, output: 0, requests: 0, cacheRead: 0, cacheCreation: 0 };
            costs[backend].input += inputTokens || 0;
            costs[backend].output += outputTokens || 0;
            costs[backend].requests++;
            costs[backend].cacheRead += cacheRead || 0;
            costs[backend].cacheCreation += cacheCreation || 0;
        }

        function getCostSummary() {
            const summary = {};
            let totalActual = 0;
            let totalAnthropic = 0;
            for (const [backend, tokens] of Object.entries(costs)) {
                const p = PRICING_PER_M[backend] || PRICING_PER_M._single;
                const ap = PRICING_PER_M.anthropic;
                const actual = (tokens.input * p.input + tokens.output * p.output
                    + tokens.cacheRead * (p.cacheRead ?? p.input)
                    + tokens.cacheCreation * p.input) / 1_000_000;
                const anthropicEq = ((tokens.input + tokens.cacheRead + tokens.cacheCreation) * ap.input + tokens.output * ap.output) / 1_000_000;
                totalActual += actual;
                totalAnthropic += anthropicEq;
                summary[backend] = {
                    input_tokens: tokens.input,
                    output_tokens: tokens.output,
                    requests: tokens.requests,
                    cost: +actual.toFixed(4),
                    anthropic_equivalent: +anthropicEq.toFixed(4),
                    ...(p.cacheRead !== undefined ? {
                        cache_read_input_tokens: tokens.cacheRead,
                        cache_creation_input_tokens: tokens.cacheCreation,
                        cost_basis: 'peak_token_estimate_excludes_search_fetch',
                    } : {}),
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
            state.modelOverride = name === 'openrouter' ? state.modelOverride : null;
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

            // These are different API contracts, not Messages. Never send a
            // DeepSeek/OpenAI payload to Anthropic under the fallback route.
            if (state.mode !== 'anthropic' && /^(?:\/beta)?(?:\/v1)?\/(?:responses|chat\/completions|completions|tools\/(?:search|fetch))(?:\/|$)/.test(urlPath)) {
                clientRes.writeHead(501, { 'content-type': 'application/json' });
                clientRes.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
                    message: 'This proxy supports Anthropic Messages, not this API family. Call the documented DeepSeek endpoint directly.' } }));
                clientReq.resume();
                return;
            }
            const routeDeepSeekFiles = /^\/v1\/files(?:\/[^/]+)?$/.test(urlPath)
                && state.mode !== 'anthropic'
                && (state.mode === 'deepseek' || state.target.hostname === 'api.deepseek.com');

            // Local estimate for backends without a count_tokens endpoint.
            // Includes system/tools, but is not a substitute for a tokenizer.
            if (urlPath === '/v1/messages/count_tokens' && clientReq.method === 'POST') {
                const chunks = [];
                let bytes = 0;
                clientReq.on('data', c => {
                    bytes += c.length;
                    if (bytes > MAX_BODY_SIZE) {
                        if (!clientRes.writableEnded) {
                            clientRes.writeHead(413, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Token count body exceeds 48 MiB' } }));
                        }
                        return;
                    }
                    chunks.push(c);
                });
                clientReq.on('end', () => {
                    if (clientRes.writableEnded) return;
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString());
                        const approx = estimateInputTokens(body);
                        clientRes.writeHead(200, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ input_tokens: approx }));
                    } catch {
                        clientRes.writeHead(400, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON for token count request' } }));
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
            const bodyLimit = routeDeepSeekFiles ? MAX_FILES_BODY_SIZE : MAX_BODY_SIZE;
            clientReq.on('data', c => {
                bodySize += c.length;
                if (bodySize > bodyLimit) {
                    if (clientRes.writableEnded) return;
                    console.error(`[MODEL-PROXY] #${reqId} BODY_TOO_LARGE (${bodySize} bytes)`);
                    clientRes.writeHead(413, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({ error: { message: routeDeepSeekFiles
                        ? 'Files upload exceeds local limit of 65 MiB including multipart envelope'
                        : 'Request body exceeds DeepSeek limit of 48 MiB' } }));
                    return;
                }
                chunks.push(c);
            });
            clientReq.on('end', () => {
                if (bodySize > bodyLimit) return;
                let body = Buffer.concat(chunks);
                const isMessagesPath = MODEL_PATHS.includes(urlPath);

                let parsed = null;
                if (isMessagesPath) {
                    try { parsed = JSON.parse(body); } catch {}
                }

                // Only a fresh image in the latest user message triggers
                // DeepSeek Vision. Older images are stripped on later text
                // turns so the conversation returns to the main code model.
                const lastMsg = parsed?.messages?.[parsed.messages.length - 1];
                const lastMessageHasImage = lastMsg?.role === 'user'
                    && containsImageBlock([lastMsg]);
                const hasImage = state.mode !== 'anthropic'
                    && state.mode !== 'minimax'
                    && !!deepseekVisionBackend
                    && lastMessageHasImage;

                const isAnthropicMode = state.mode === 'anthropic';
                const isModelCall = !isAnthropicMode && isMessagesPath;

                if (isModelCall && lastMessageHasImage && state.mode !== 'minimax' && !deepseekVisionBackend) {
                    console.error(`[MODEL-PROXY] #${reqId} image rejected: DEEPSEEK_API_KEY is not available for native vision routing`);
                    clientRes.writeHead(503, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({
                        error: {
                            message: 'Image input requires DEEPSEEK_API_KEY for deepseek-flash',
                        },
                    }));
                    return;
                }

                // The wire uses DeepSeek's vision model while the response is
                // rewritten to the model name Claude Code originally sent.
                let imageRewrite = null;
                let effectiveMode = state.mode;
                let dest, fullPath, headers;

                if (hasImage) {
                    let prepared;
                    try {
                        prepared = prepareDeepSeekVisionRequest(parsed);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : 'invalid image input';
                        console.error(`[MODEL-PROXY] #${reqId} image rejected: ${message}`);
                        clientRes.writeHead(400, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ error: { message } }));
                        return;
                    }
                    sanitizeToolSchemasForBackend(parsed);
                    imageRewrite = prepared?.originalModel
                        ? { backend: prepared.originalModel, canonical: prepared.visionModel }
                        : null;
                    dest = deepseekVisionBackend.target;
                    headers = { ...clientReq.headers, host: dest.host };
                    delete headers['content-length'];
                    delete headers['authorization'];
                    delete headers['x-api-key'];
                    headers['anthropic-beta'] = withFilesBeta(headers['anthropic-beta']);
                    headers['x-api-key'] = deepseekVisionBackend.apiKey;
                    effectiveMode = 'deepseek_vision';
                    body = Buffer.from(JSON.stringify(parsed));
                    fullPath = buildUpstreamPath(dest, clientReq.url);
                    console.error(`[MODEL-PROXY] #${reqId} [image→${DEEPSEEK_VISION_MODEL}]`);
                } else {
                    // Normal routing
                    dest = isModelCall || routeDeepSeekFiles ? state.target : new URL(ANTHROPIC_FALLBACK);

                    let fullPathBase;
                    if (isModelCall || routeDeepSeekFiles) {
                        fullPathBase = buildUpstreamPath(state.target, clientReq.url);
                    } else {
                        fullPathBase = clientReq.url;
                    }
                    fullPath = fullPathBase;

                    headers = { ...clientReq.headers, host: dest.host };
                    delete headers['content-length'];

                    if (isModelCall || routeDeepSeekFiles) {
                        delete headers['authorization'];
                        delete headers['x-api-key'];
                        if (state.useBearer) {
                            headers['authorization'] = `Bearer ${state.apiKey}`;
                        } else {
                            headers['x-api-key'] = state.apiKey;
                        }
                        if (routeDeepSeekFiles) headers['anthropic-beta'] = withFilesBeta(headers['anthropic-beta']);
                    }

                    // Strip stale images from message history so a single
                    // image turn doesn't pin the rest of the conversation to
                    // the fallback provider.
                    if (isModelCall && parsed?.['messages'] && !lastMessageHasImage) {
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
                if (trackUsage && mockTitleGeneration) {
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
                if (isModelCall && !hasImage && (state.modelOverride || MODEL_REMAP[state.mode])) {
                    try {
                        const p = JSON.parse(body);
                        let mapped;
                        if (state.modelOverride && state.mode === 'openrouter') {
                            mapped = state.modelOverride;
                            console.error(`[MODEL-PROXY] #${reqId} custom model: ${p.model} → ${mapped}`);
                        }
                        const remap = MODEL_REMAP[state.mode];
                        if (!mapped && remap) mapped = remap[p.model];
                        if (!mapped) {
                            const tier = p.model.includes('fable') ? 'fable'
                                : p.model.includes('opus') ? 'opus'
                                : p.model.includes('sonnet') ? 'sonnet'
                                : p.model.includes('haiku') ? 'haiku'
                                : null;
                            if (remap?._default && tier) {
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

                // Strict backend schema validators reject the Unicode property
                // escapes in Claude Code tool `pattern` keywords; drop them for
                // every non-Anthropic model call (see sanitizeToolSchemasForBackend).
                if (isModelCall) {
                    try {
                        const p = JSON.parse(body);
                        if (sanitizeToolSchemasForBackend(p)) {
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
                        prepareBackendOptions(p, dest.hostname === 'api.deepseek.com' || state.mode === 'deepseek' || hasImage);
                        body = Buffer.from(JSON.stringify(p));
                    } catch { /* pass through */ }
                }

                // The proxy inspects and normalizes model responses. Request
                // identity encoding for every tracked model call so JSON/SSE
                // parsers never receive compressed bytes without a decoder.
                const finalHeaders = { ...headers, 'content-length': body.length };
                if (trackUsage) {
                    delete finalHeaders['accept-encoding'];
                }

                const opts = {
                    hostname: dest.hostname,
                    port: dest.port || 443,
                    path: fullPath,
                    method: clientReq.method,
                    headers: finalHeaders,
                    timeout: routeDeepSeekFiles ? 10 * 60 * 1000 : REQUEST_TIMEOUT_MS,
                };

                let downstreamDisconnected = false;
                let upstreamResponse = null;
                const cancelUpstream = () => {
                    if (clientRes.writableEnded) return;
                    downstreamDisconnected = true;
                    upstreamResponse?.destroy();
                    proxyReq.destroy();
                };

                clientReq.once('aborted', cancelUpstream);
                clientRes.once('close', cancelUpstream);

                const proxyReq = upstreamRequest(opts, (proxyRes) => {
                    upstreamResponse = proxyRes;
                    if (trackUsage) {
                        const ttfb = Date.now() - t0;
                        console.error(`[MODEL-PROXY] #${reqId} TTFB ${ttfb}ms (status ${proxyRes.statusCode})`);
                        if (proxyRes.statusCode >= 400) {
                            console.error(`[MODEL-PROXY] #${reqId} UPSTREAM_HTTP_ERROR status=${proxyRes.statusCode}`);
                        }
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
                        const sseHeaders = { ...proxyRes.headers };
                        // Usage normalization and model rewrites can change the
                        // byte length on every Messages stream, not just vision.
                        delete sseHeaders['content-length'];
                        delete sseHeaders['content-encoding'];
                        clientRes.writeHead(proxyRes.statusCode, sseHeaders);
                        const modelRewrite = imageRewrite
                            ? { from: imageRewrite.canonical, to: imageRewrite.backend }
                            : null;
                        let terminalTimer = null;
                        let semanticStallTimer = null;
                        let semanticFinished = false;
                        let terminalIntentReceived = false;
                        const openContentBlocks = new Set();
                        let norm;

                        const finishSemanticStream = (synthesizeMessageStop) => {
                            if (semanticFinished) return;
                            semanticFinished = true;
                            clearTimeout(terminalTimer);
                            clearTimeout(semanticStallTimer);
                            proxyRes.unpipe(norm);
                            if (synthesizeMessageStop) {
                                console.error(`[MODEL-PROXY] #${reqId} synthesized missing message_stop`);
                                norm.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
                            }
                            norm.end();
                            logSseResp();
                            proxyRes.destroy();
                        };

                        const failStalledSemanticStream = () => {
                            if (semanticFinished) return;
                            semanticFinished = true;
                            clearTimeout(terminalTimer);
                            clearTimeout(semanticStallTimer);
                            proxyRes.unpipe(norm);
                            const message = `Upstream generation stalled: no semantic SSE events for ${semanticStallTimeoutMs}ms`;
                            console.error(`[MODEL-PROXY] #${reqId} ${message}`);
                            norm.write(`event: error\ndata: ${JSON.stringify({
                                type: 'error',
                                error: { type: 'api_error', message },
                            })}\n\n`);
                            norm.end();
                            proxyRes.destroy();
                        };

                        const refreshSemanticWatchdog = () => {
                            if (semanticFinished || semanticStallTimeoutMs <= 0) return;
                            clearTimeout(semanticStallTimer);
                            semanticStallTimer = setTimeout(
                                failStalledSemanticStream,
                                semanticStallTimeoutMs,
                            );
                            semanticStallTimer.unref?.();
                        };

                        const scheduleMissingStopFallback = () => {
                            if (!terminalIntentReceived || openContentBlocks.size > 0) return;
                            clearTimeout(terminalTimer);
                            terminalTimer = setTimeout(
                                () => finishSemanticStream(true),
                                terminalGraceMs,
                            );
                            terminalTimer.unref?.();
                        };

                        // Clean SSE completion destroys the upstream socket
                        // (message_stop path), so 'end' may never fire. Log the
                        // response metadata exactly once, from whichever
                        // terminal path runs first.
                        let respLogged = false;
                        const logSseResp = () => {
                            if (respLogged || !norm) return;
                            respLogged = true;
                            console.error(formatContextResponse(reqId, {
                                status: proxyRes.statusCode,
                                responseBytes: norm._respBytes,
                                inputTokens: norm._sawInputUsage ? norm._inputTokens : null,
                                outputTokens: norm._sawOutputUsage ? norm._outputTokens : null,
                                cacheRead: norm._cacheRead,
                                cacheCreation: norm._cacheCreation,
                                respMeta: norm._respMeta,
                            }));
                        };

                        norm = new UsageNormalizer(
                            (inp, out, cacheRead, cacheCreation) => recordUsage(effectiveMode, inp, out, cacheRead, cacheCreation),
                            {
                                modelRewrite,
                                onParseError(err, eventSize) {
                                    console.error(`[MODEL-PROXY] #${reqId} SSE_JSON_PARSE_ERROR bytes=${eventSize}: ${err.message}`);
                                },
                                onSemanticEvent(event) {
                                    // Anthropic ping events and DeepSeek's
                                    // comment keep-alives prove only that the
                                    // socket is alive, not that generation is
                                    // making progress.
                                    if (event.type !== 'ping') refreshSemanticWatchdog();
                                    if (event.type === 'content_block_start') {
                                        openContentBlocks.add(event.index);
                                        return;
                                    }
                                    if (event.type === 'content_block_stop') {
                                        openContentBlocks.delete(event.index);
                                        scheduleMissingStopFallback();
                                        return;
                                    }
                                    if (event.type === 'message_stop') {
                                        finishSemanticStream(false);
                                        return;
                                    }
                                    if (event.type === 'message_delta' && event.delta?.stop_reason) {
                                        terminalIntentReceived = true;
                                        scheduleMissingStopFallback();
                                    }
                                },
                            },
                        );
                        proxyRes.pipe(norm).pipe(clientRes);
                        refreshSemanticWatchdog();
                        clientRes.once('close', () => {
                            semanticFinished = true;
                            clearTimeout(terminalTimer);
                            clearTimeout(semanticStallTimer);
                        });
                        proxyRes.on('end', () => {
                            clearTimeout(terminalTimer);
                            clearTimeout(semanticStallTimer);
                            semanticFinished = true;
                            console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${norm._inputTokens}in/${norm._outputTokens}out)`);
                            logSseResp();
                        });
                    } else if (trackUsage && ct.includes('application/json')) {
                        const respChunks = [];
                        proxyRes.on('data', c => respChunks.push(c));
                        proxyRes.on('end', () => {
                            const raw = Buffer.concat(respChunks);
                            let claimedUsage = null;
                            try {
                                const rawJson = JSON.parse(raw.toString());
                                if (rawJson && typeof rawJson.usage === 'object' && rawJson.usage) {
                                    claimedUsage = rawJson.usage;
                                }
                            } catch { /* presence check only */ }
                            let fixed = normalizeJsonBody(raw);
                            let respMeta = null;
                            try {
                                const j = JSON.parse(fixed);
                                if (j.usage) recordUsage(effectiveMode, j.usage.input_tokens, j.usage.output_tokens, j.usage.cache_read_input_tokens, j.usage.cache_creation_input_tokens);
                                if (imageRewrite && j.model === imageRewrite.canonical) {
                                    j.model = imageRewrite.backend;
                                    fixed = Buffer.from(JSON.stringify(j));
                                }
                                respMeta = computeResponseMetadata(j);
                            } catch (err) {
                                console.error(`[MODEL-PROXY] #${reqId} JSON_RESPONSE_PARSE_ERROR status=${proxyRes.statusCode} bytes=${fixed.length}: ${err.message}`);
                            }
                            const jsonHeaders = { ...proxyRes.headers };
                            // The body was buffered and may have been
                            // rewritten, so the upstream transfer framing is
                            // no longer valid alongside our content-length.
                            delete jsonHeaders['transfer-encoding'];
                            delete jsonHeaders['content-encoding'];
                            const outHeaders = { ...jsonHeaders, 'content-length': fixed.length };
                            clientRes.writeHead(proxyRes.statusCode, outHeaders);
                            clientRes.end(fixed);
                            const um = extractUsageMetrics(claimedUsage);
                            console.error(formatContextResponse(reqId, {
                                status: proxyRes.statusCode,
                                responseBytes: fixed.length,
                                inputTokens: um.inputTokens,
                                outputTokens: um.outputTokens,
                                cacheRead: um.cacheRead,
                                cacheCreation: um.cacheCreation,
                                respMeta,
                            }));
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
                    if (downstreamDisconnected) return;
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

                // Metadata-only context telemetry: sizes and counts, never content.
                // Computed from the final (post-transform) body so the numbers
                // describe exactly what goes upstream. Pure function — the
                // request itself is untouched.
                if (trackUsage) {
                    try {
                        const finalParsed = JSON.parse(body.toString());
                        const ctx = computeContextMetrics(finalParsed, body.length);
                        console.error(formatContextLine(reqId, effectiveMode, ctx));
                        if (needsContextWarning(ctx)) {
                            console.error(formatContextWarning(reqId, effectiveMode, ctx));
                        }
                    } catch { /* telemetry must never break proxying */ }
                }

                inFlight++;
                proxyReq.once('close', () => {
                    inFlight = Math.max(0, inFlight - 1);
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
                const gracefulShutdown = (timeoutMs = 2000) => new Promise((res) => {
                    server.close();
                    const t0 = Date.now();
                    const tick = () => {
                        if (inFlight <= 0 || Date.now() - t0 >= timeoutMs) {
                            server.closeAllConnections?.();
                            res();
                        } else {
                            setTimeout(tick, 25);
                        }
                    };
                    tick();
                });
                proxyShutdownRegistry.add(gracefulShutdown);
                installProxySignalHandlers();
                resolve({
                    port: actualPort,
                    close: () => server.close(),
                    switchMode,
                    gracefulShutdown,
                    getInFlightCount: () => inFlight,
                });
            });
        }

        tryListen(startPort);
    });
}
