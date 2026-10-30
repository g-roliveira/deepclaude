import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';

import {
    CONTEXT_WARN_TOOLS_BYTES,
    CONTEXT_WARN_TOOLS_COUNT,
    DEEPSEEK_VISION_MODEL,
    buildUpstreamPath,
    computeContextMetrics,
    computeResponseMetadata,
    containsImageBlock,
    extractUsageMetrics,
    formatContextLine,
    formatContextResponse,
    formatContextWarning,
    needsContextWarning,
    prepareDeepSeekVisionRequest,
    prepareBackendOptions,
    estimateInputTokens,
    sanitizeToolSchemasForBackend,
    startModelProxy,
    stripImagesFromMessages,
} from './model-proxy.js';

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closeServer(server) {
    server.closeAllConnections?.();
    server.close();
}

function within(promise, milliseconds) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`timed out after ${milliseconds}ms`)),
            milliseconds,
        )),
    ]);
}

const image = {
    type: 'image',
    source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgo=',
    },
};

test('detects direct and Read tool_result image blocks', () => {
    assert.equal(containsImageBlock([
        { role: 'user', content: [{ type: 'text', text: 'describe' }, image] },
    ]), true);

    assert.equal(containsImageBlock([
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: 'tool_1',
                content: [{ type: 'text', text: 'image read' }, image],
            }],
        },
    ]), true);
});

test('prepares only a latest user image turn for native vision', () => {
    const request = {
        model: 'deepseek-v4-pro',
        thinking: { type: 'enabled', budget_tokens: 1024 },
        context_management: { edits: [] },
        messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
            { role: 'user', content: [{ type: 'text', text: 'what is this?' }, image] },
        ],
    };

    const prepared = prepareDeepSeekVisionRequest(request);

    assert.deepEqual(prepared, {
        originalModel: 'deepseek-v4-pro',
        visionModel: DEEPSEEK_VISION_MODEL,
    });
    assert.equal(request.model, DEEPSEEK_VISION_MODEL);
    assert.deepEqual(request.thinking, { type: 'enabled' });
    assert.equal(request.context_management, undefined);
    assert.equal(request.messages[1].content[1], image);
});

test('removes historical images before sending the current vision turn', () => {
    const historicalImage = {
        ...image,
        source: { ...image.source, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
    };
    const request = {
        model: 'deepseek-v4-pro',
        messages: [
            { role: 'user', content: [historicalImage] },
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'tool_2',
                    content: [image],
                }],
            },
        ],
    };

    prepareDeepSeekVisionRequest(request);

    assert.deepEqual(request.messages[0].content[0], {
        type: 'text',
        text: '[image omitted]',
    });
    assert.equal(request.messages[1].content[0].content[0], image);
});

test('rejects malformed or mismatched base64 image payloads', () => {
    const malformed = {
        model: 'deepseek-flash',
        messages: [{
            role: 'user',
            content: [{
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'not-base64' },
            }],
        }],
    };

    assert.throws(
        () => prepareDeepSeekVisionRequest(malformed),
        /invalid base64 data/,
    );

    const mismatched = {
        model: 'deepseek-flash',
        messages: [{
            role: 'user',
            content: [{
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: '/9j/4AAQSkZJRg==' },
            }],
        }],
    };

    assert.throws(
        () => prepareDeepSeekVisionRequest(mismatched),
        /bytes do not match media_type image\/png/,
    );
});

test('does not route an assistant image or an image only in old history', () => {
    const assistantImage = {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'assistant', content: [image] }],
    };
    assert.equal(prepareDeepSeekVisionRequest(assistantImage), null);

    const oldImage = {
        model: 'deepseek-v4-pro',
        messages: [
            { role: 'user', content: [image] },
            { role: 'assistant', content: [{ type: 'text', text: 'seen' }] },
            { role: 'user', content: [{ type: 'text', text: 'continue' }] },
        ],
    };
    assert.equal(prepareDeepSeekVisionRequest(oldImage), null);
});

test('strips stale direct and nested images without losing tool results', () => {
    const messages = [{
        role: 'user',
        content: [
            image,
            {
                type: 'tool_result',
                tool_use_id: 'tool_1',
                content: [{ type: 'text', text: 'metadata' }, image],
            },
        ],
    }];

    assert.equal(stripImagesFromMessages(messages), 2);
    assert.deepEqual(messages[0].content[0], { type: 'text', text: '[image omitted]' });
    assert.equal(messages[0].content[1].type, 'tool_result');
    assert.deepEqual(messages[0].content[1].content[1], {
        type: 'text',
        text: '[image omitted]',
    });
});

test('builds DeepSeek Anthropic path without dropping Claude Code query flags', () => {
    const target = new URL('https://api.deepseek.com/anthropic');
    assert.equal(
        buildUpstreamPath(target, '/v1/messages?beta=true'),
        '/anthropic/v1/messages?beta=true',
    );
});

test('routes the minimax backend to OpenRouter with its free model', async () => {
    let receivedBody;
    const upstream = createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_test',
                type: 'message',
                model: 'minimax/minimax-m3:free',
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 2, output_tokens: 1 },
            }));
        });
    });

    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'test-key',
        startPort: 0,
        backends: {
            minimax: { url: `http://127.0.0.1:${upstreamPort}/api/v1`, apiKey: 'test-key' },
        },
        defaultMode: 'minimax',
        upstreamRequest: httpRequest,
    });

    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-opus-5',
                max_tokens: 32,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });
        assert.equal(response.status, 200);
        assert.equal(receivedBody.model, 'minimax/minimax-m3:free');
    } finally {
        proxy.close();
        closeServer(upstream);
    }
});

test('routes an OpenRouter model override without changing the Claude Code model label', async () => {
    let receivedBody;
    const upstream = createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_custom',
                type: 'message',
                model: 'inclusionai/ling-3.0-flash-sante:free',
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 2, output_tokens: 1 },
            }));
        });
    });

    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api`,
        apiKey: 'test-key',
        startPort: 0,
        backends: {
            openrouter: { url: `http://127.0.0.1:${upstreamPort}/api`, apiKey: 'test-key' },
        },
        defaultMode: 'openrouter',
        modelOverride: 'inclusionai/ling-3.0-flash-sante:free',
        upstreamRequest: httpRequest,
    });

    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-opus-5',
                max_tokens: 32,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });
        assert.equal(response.status, 200);
        assert.equal(receivedBody.model, 'inclusionai/ling-3.0-flash-sante:free');
    } finally {
        proxy.close();
        closeServer(upstream);
    }
});

test('requests uncompressed model responses so JSON remains parseable', async () => {
    let receivedEncoding;
    const payload = JSON.stringify({
        id: 'msg_gzip',
        type: 'message',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 2, output_tokens: 1 },
    });
    const upstream = createServer((req, res) => {
        receivedEncoding = req.headers['accept-encoding'];
        const compressed = Boolean(receivedEncoding);
        const body = compressed ? gzipSync(payload) : Buffer.from(payload);
        res.writeHead(200, {
            'content-type': 'application/json',
            ...(compressed ? { 'content-encoding': 'gzip' } : {}),
        });
        res.end(body);
    });

    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
    });

    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'minimax/minimax-m3:free',
                max_tokens: 32,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });
        const json = await response.json();

        assert.equal(receivedEncoding, undefined);
        assert.equal(json.content[0].text, 'ok');
    } finally {
        proxy.close();
        closeServer(upstream);
    }
});

test('finishes the downstream SSE when upstream omits message_stop and EOF', async () => {
    let keepAlive;
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-pro","usage":{"input_tokens":12,"output_tokens":0}}}\n\n');
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n');
            res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
            res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n');
            keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 10);
        });
    });

    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
        terminalGraceMs: 25,
    });
    const abort = new AbortController();

    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-v4-pro',
                max_tokens: 1024,
                stream: true,
                messages: [{ role: 'user', content: 'hello' }],
            }),
            signal: abort.signal,
        });
        const output = await within(response.text(), 250);
        const cost = await fetch(`http://127.0.0.1:${proxy.port}/_proxy/cost`).then(r => r.json());

        assert.match(output, /event: message_stop\ndata: {"type":"message_stop"}/);
        assert.deepEqual(cost.backends._single, {
            input_tokens: 12,
            output_tokens: 1,
            requests: 1,
            cost: 0,
            anthropic_equivalent: 0.0001,
        });
    } finally {
        abort.abort();
        clearInterval(keepAlive);
        proxy.close();
        closeServer(upstream);
    }
});

test('finishes immediately on upstream message_stop without duplicating it', async () => {
    let keepAlive;
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-pro","usage":{"input_tokens":4,"output_tokens":0}}}\n\n');
            res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 10);
        });
    });

    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
        terminalGraceMs: 100,
    });
    const abort = new AbortController();

    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-v4-pro',
                max_tokens: 1024,
                stream: true,
                messages: [{ role: 'user', content: 'hello' }],
            }),
            signal: abort.signal,
        });
        const output = await within(response.text(), 250);
        const stops = output.match(/event: message_stop/g) || [];

        assert.equal(stops.length, 1);
    } finally {
        abort.abort();
        clearInterval(keepAlive);
        proxy.close();
        closeServer(upstream);
    }
});

test('cancels the upstream stream when the downstream client disconnects', async () => {
    let keepAlive;
    let notifyUpstreamClosed;
    const upstreamClosed = new Promise(resolve => { notifyUpstreamClosed = resolve; });
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.on('close', notifyUpstreamClosed);
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-pro","usage":{"input_tokens":4,"output_tokens":0}}}\n\n');
            keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 10);
        });
    });

    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
    });
    const abort = new AbortController();

    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-v4-pro',
                max_tokens: 1024,
                stream: true,
                messages: [{ role: 'user', content: 'hello' }],
            }),
            signal: abort.signal,
        });
        await response.body.getReader().read();
        abort.abort();

        await within(upstreamClosed, 250);
    } finally {
        abort.abort();
        clearInterval(keepAlive);
        proxy.close();
        closeServer(upstream);
    }
});

test('does not synthesize message_stop while a content block is still open', async () => {
    let finishResponse;
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-pro","usage":{"input_tokens":4,"output_tokens":0}}}\n\n');
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
            res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n');
            finishResponse = setTimeout(() => {
                res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"late"}}\n\n');
                res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
                res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            }, 50);
        });
    });

    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
        terminalGraceMs: 20,
    });
    const abort = new AbortController();

    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-v4-pro',
                max_tokens: 1024,
                stream: true,
                messages: [{ role: 'user', content: 'hello' }],
            }),
            signal: abort.signal,
        });
        const output = await within(response.text(), 200);

        assert.match(output, /"text":"late"/);
    } finally {
        abort.abort();
        clearTimeout(finishResponse);
        proxy.close();
        closeServer(upstream);
    }
});

test('fails a stalled SSE stream even when upstream keep-alives continue', async () => {
    let keepAlive;
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-pro","usage":{"input_tokens":4,"output_tokens":0}}}\n\n');
            res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"partial"}}\n\n');
            keepAlive = setInterval(() => {
                res.write(': keep-alive\n\n');
                res.write('event: ping\ndata: {"type":"ping"}\n\n');
            }, 5);
        });
    });

    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
        semanticStallTimeoutMs: 30,
    });
    const abort = new AbortController();

    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-v4-pro',
                max_tokens: 1024,
                stream: true,
                messages: [{ role: 'user', content: 'hello' }],
            }),
            signal: abort.signal,
        });
        const output = await within(response.text(), 250);

        assert.match(
            output,
            /event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Upstream generation stalled: no semantic SSE events for 30ms"}}/,
        );
    } finally {
        abort.abort();
        clearInterval(keepAlive);
        proxy.close();
        closeServer(upstream);
    }
});

test('sanitizeToolSchemasForBackend strips pattern keywords from tool schemas', () => {
    const body = {
        model: 'claude-opus-4-6',
        tools: [
            {
                name: 'Artifact',
                input_schema: {
                    type: 'object',
                    properties: {
                        file_path: { type: 'string', pattern: '^(?!__.*__$)[^\\p{Cc}\\p{Cf}]{1,200}$' },
                    },
                },
            },
            {
                name: 'Edit',
                input_schema: {
                    type: 'object',
                    properties: {
                        meta: { type: 'object', properties: { x: { type: 'string', pattern: '[a-z]+' } } },
                    },
                },
            },
        ],
    };
    assert.equal(sanitizeToolSchemasForBackend(body), true);
    const artifact = body.tools[0].input_schema;
    assert.equal(artifact.properties.file_path.pattern, undefined);
    assert.equal(artifact.properties.file_path.type, 'string');
    assert.equal(body.tools[0].name, 'Artifact');
    assert.equal(body.tools[1].input_schema.properties.meta.properties.x.pattern, undefined);
    assert.equal(body.model, 'claude-opus-4-6');
});

test('sanitizeToolSchemasForBackend is a no-op without pattern keywords', () => {
    const body = {
        tools: [{ name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    };
    assert.equal(sanitizeToolSchemasForBackend(body), false);
    assert.equal(body.tools[0].input_schema.properties.command.pattern, undefined);
});

/* Wave 1 context telemetry: metadata-only, never content. */

function canaryBody() {
    return {
        model: 'deepseek-flash',
        system: [{ type: 'text', text: 'CANARY_SYSTEM_PROMPT_TEXT_9f8e' }],
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'CANARY_USER_PROMPT_HELLO_WORLD' }] },
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'CANARY_TOOL_ARG_LS' } }],
            },
            {
                role: 'user',
                content: [{
                    type: 'tool_result', tool_use_id: 't1',
                    content: [{ type: 'text', text: 'CANARY_TOOL_RESULT_OUTPUT' }],
                }],
            },
        ],
        tools: [
            { name: 'Bash', description: 'CANARY_TOOL_SCHEMA_DESC', input_schema: { type: 'object' } },
            { name: 'ToolSearch', description: 'search', input_schema: { type: 'object' } },
            { name: 'DeferredHelper', description: 'placeholder without schema' },
        ],
    };
}

test('computeContextMetrics counts tools, deferred, ToolSearch, images, tool_refs', () => {
    const body = canaryBody();
    body.messages.push({
        role: 'user',
        content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            { type: 'tool_reference', tool_name: 'Bash' },
        ],
    });
    const m = computeContextMetrics(body, 1234);
    assert.equal(m.model, 'deepseek-flash');
    assert.equal(m.requestBytes, 1234);
    assert.equal(m.toolsCount, 3);
    assert.equal(m.deferredToolsCount, 1);
    assert.equal(m.nonDeferredToolsCount, 2);
    assert.equal(m.hasToolSearchTool, true);
    assert.equal(m.imageCount, 1);
    assert.equal(m.toolReferenceCountInMessages, 1);
});

test('computeContextMetrics counts bytes exactly', () => {
    const body = canaryBody();
    const raw = JSON.stringify(body);
    const m = computeContextMetrics(body, raw.length);
    assert.equal(m.toolsBytes, Buffer.byteLength(JSON.stringify(body.tools)));
    assert.equal(m.systemBytes, Buffer.byteLength(JSON.stringify(body.system)));
    assert.equal(m.messagesBytes, Buffer.byteLength(JSON.stringify(body.messages)));
    assert.equal(m.requestBytes, raw.length);
});

test('computeContextMetrics handles missing sections and never mutates input', () => {
    const body = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
    Object.freeze(body);
    Object.freeze(body.messages);
    const before = JSON.stringify(body);
    const m = computeContextMetrics(body, 10);
    assert.equal(m.toolsCount, 0);
    assert.equal(m.toolsBytes, 0);
    assert.equal(m.systemBytes, 0);
    assert.equal(m.imageCount, 0);
    assert.equal(m.hasToolSearchTool, false);
    assert.equal(JSON.stringify(body), before);
});

test('context formatters never leak prompt, schema, key, or auth content', () => {
    const m = computeContextMetrics(canaryBody(), 999);
    const lines = [
        formatContextLine(7, 'ds', m),
        formatContextWarning(7, 'ds', m),
        formatContextResponse(7, {
            status: 200, responseBytes: 50,
            inputTokens: 3, outputTokens: 1, cacheRead: 2, cacheCreation: 0,
        }),
        formatContextResponse(7, {
            status: 200, responseBytes: 50,
            inputTokens: null, outputTokens: null, cacheRead: null, cacheCreation: null,
        }),
    ];
    const forbidden = [
        'CANARY_SYSTEM_PROMPT_TEXT_9f8e',
        'CANARY_USER_PROMPT_HELLO_WORLD',
        'CANARY_TOOL_ARG_LS',
        'CANARY_TOOL_RESULT_OUTPUT',
        'CANARY_TOOL_SCHEMA_DESC',
        'sk-ant-canary-key-123',
        'Bearer canary-auth-token',
    ];
    for (const line of lines) {
        for (const secret of forbidden) {
            assert.ok(!line.includes(secret), `leak in: ${line}`);
        }
    }
    assert.match(lines[0], /^\[context\] req=7 mode=ds model=deepseek-flash tools=3 /);
    assert.match(lines[1], /^\[context-warning\] LARGE TOOL CONTEXT req=7 /);
    assert.match(lines[2], /in=3 out=1 cache_read=2 cache_create=0/);
    assert.match(lines[3], /in=na out=na cache_read=na cache_create=na/);
});

test('context warning fires only at or above thresholds', () => {
    assert.equal(CONTEXT_WARN_TOOLS_COUNT, 100);
    assert.equal(CONTEXT_WARN_TOOLS_BYTES, 524288);
    const tiny = (i) => ({ name: `t${i}`, input_schema: { type: 'object' } });
    const below = computeContextMetrics({ model: 'm', tools: Array.from({ length: 99 }, (_, i) => tiny(i)) }, 1);
    assert.equal(needsContextWarning(below), false);
    const atCount = computeContextMetrics({ model: 'm', tools: Array.from({ length: 100 }, (_, i) => tiny(i)) }, 1);
    assert.equal(needsContextWarning(atCount), true);
    const bigDesc = 'x'.repeat(CONTEXT_WARN_TOOLS_BYTES);
    const atBytes = computeContextMetrics({ model: 'm', tools: [{ name: 'big', input_schema: { type: 'object', description: bigDesc } }] }, 1);
    assert.equal(atBytes.toolsCount, 1);
    assert.equal(needsContextWarning(atBytes), true);
});

test('extractUsageMetrics picks counters and nulls absent fields', () => {
    assert.deepEqual(
        extractUsageMetrics({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 }),
        { inputTokens: 5, outputTokens: 2, cacheRead: 4, cacheCreation: 1 },
    );
    assert.deepEqual(
        extractUsageMetrics({ input_tokens: 5 }),
        { inputTokens: 5, outputTokens: null, cacheRead: null, cacheCreation: null },
    );
    assert.deepEqual(
        extractUsageMetrics(null),
        { inputTokens: null, outputTokens: null, cacheRead: null, cacheCreation: null },
    );
});

test('proxy emits metadata-only [context] lines without changing the wire request', async () => {
    const captured = [];
    const origError = console.error;
    console.error = (...args) => captured.push(args.join(' '));
    let receivedBody;
    let receivedAuth;
    const upstream = createServer((req, res) => {
        const chunks = [];
        receivedAuth = req.headers['authorization'] ?? req.headers['x-api-key'];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            receivedBody = JSON.parse(Buffer.concat(chunks));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_ctx',
                type: 'message',
                role: 'assistant',
                model: 'deepseek-flash',
                content: [{ type: 'text', text: 'CANARY_RESPONSE_TEXT' }],
                usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7 },
            }));
        });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'sk-ant-canary-key-123',
        startPort: 0,
        upstreamRequest: httpRequest,
    });
    try {
        const sent = canaryBody();
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer canary-auth-token',
            },
            body: JSON.stringify(sent),
        });
        assert.equal(response.status, 200);
        const clientJson = await response.json();
        // Response passes through byte-identical (usage present, no redacted blocks).
        assert.deepEqual(clientJson.content, [{ type: 'text', text: 'CANARY_RESPONSE_TEXT' }]);
        assert.deepEqual(clientJson.usage, { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7 });
        // Request carries only the documented pattern-strip (none here); model raw in _single mode.
        assert.equal(receivedBody.model, 'deepseek-flash');
        assert.deepEqual(receivedBody.messages, sent.messages);
        assert.deepEqual(receivedBody.tools, sent.tools);
        // Telemetry lines exist and leak nothing.
        const ctx = captured.filter(l => l.startsWith('[context] '));
        const resp = captured.filter(l => l.startsWith('[context-resp] '));
        const warn = captured.filter(l => l.startsWith('[context-warning]'));
        assert.equal(ctx.length, 1);
        assert.equal(resp.length, 1);
        assert.equal(warn.length, 0);
        assert.match(ctx[0], /tools=3 tools_bytes=\d+ request_bytes=\d+ system_bytes=\d+ messages_bytes=\d+/);
        assert.match(ctx[0], /deferred=1 non_deferred=2 tool_search=true/);
        assert.match(resp[0], /status=200 resp_bytes=\d+ in=11 out=3 cache_read=7 cache_create=na/);
        for (const line of [...ctx, ...resp]) {
            assert.ok(!line.includes('CANARY_'), `content leak: ${line}`);
            assert.ok(!line.includes('sk-ant-canary-key-123'), `key leak: ${line}`);
            assert.ok(!line.includes('canary-auth-token'), `auth leak: ${line}`);
        }
        assert.ok(!String(receivedAuth).includes('canary-auth-token'), 'client auth must not reach upstream in _single mode');
    } finally {
        console.error = origError;
        proxy.close();
        closeServer(upstream);
    }
});

test('proxy emits [context-warning] for large tool contexts without blocking', async () => {
    const captured = [];
    const origError = console.error;
    console.error = (...args) => captured.push(args.join(' '));
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_big', type: 'message', role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 1, output_tokens: 1 },
            }));
        });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
    });
    try {
        const tools = Array.from({ length: 100 }, (_, i) => ({ name: `t${i}`, input_schema: { type: 'object' } }));
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], tools }),
        });
        assert.equal(response.status, 200);
        await response.json();
        const warn = captured.filter(l => l.startsWith('[context-warning]'));
        assert.equal(warn.length, 1);
        assert.match(warn[0], /LARGE TOOL CONTEXT req=\d+ mode=_single model=deepseek-flash tools=100 /);
    } finally {
        console.error = origError;
        proxy.close();
        closeServer(upstream);
    }
});

/* Wave 2: response protocol metadata + graceful shutdown. */

test('computeResponseMetadata extracts types/names/markers without content', () => {
    const msg = {
        stop_reason: 'tool_use',
        content: [
            { type: 'text', text: 'CANARY_RESPONSE_PROSE_SECRET' },
            { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'CANARY_ARG_RM' } },
            { type: 'server_tool_use', id: 'b', name: 'mcp__sentry__list', input: { x: 'CANARY_INPUT' } },
            { type: 'tool_search_tool_result', tool_use_id: 'c', content: ['CANARY_SEARCH'] },
            { type: 'tool_reference', tool_name: 'Bash' },
        ],
    };
    const before = JSON.stringify(msg);
    const m = computeResponseMetadata(msg);
    assert.deepEqual(m.blockTypes, ['text', 'tool_use', 'server_tool_use', 'tool_search_tool_result', 'tool_reference']);
    assert.deepEqual(m.toolUseNames, ['Bash']);
    assert.deepEqual(m.serverToolUseNames, ['mcp__sentry__list']);
    assert.equal(m.toolSearchResultCount, 1);
    assert.equal(m.toolReferenceCount, 1);
    assert.equal(m.stopReason, 'tool_use');
    assert.equal(JSON.stringify(msg), before);
    const line = formatContextResponse(9, {
        status: 200, responseBytes: 10, inputTokens: 1, outputTokens: 1,
        cacheRead: null, cacheCreation: null, respMeta: m,
    });
    assert.match(line, /blocks=text,tool_use,server_tool_use,tool_search_tool_result,tool_reference/);
    assert.match(line, /tool_uses=Bash server_tools=mcp__sentry__list ts_results=1 tool_refs=1 stop=tool_use/);
    for (const secret of ['CANARY_RESPONSE_PROSE_SECRET', 'CANARY_ARG_RM', 'CANARY_INPUT', 'CANARY_SEARCH']) {
        assert.ok(!line.includes(secret), `content leak: ${line}`);
    }
});

test('computeResponseMetadata tolerates missing/empty messages', () => {
    assert.deepEqual(computeResponseMetadata(null), {
        blockTypes: [], toolUseNames: [], serverToolUseNames: [],
        toolSearchResultCount: 0, toolReferenceCount: 0, stopReason: null,
    });
    const line = formatContextResponse(1, { status: 200, responseBytes: 5 });
    assert.match(line, /blocks=- tool_uses=- server_tools=- ts_results=0 tool_refs=0 stop=-/);
});

test('proxy logs response block metadata on JSON responses', async () => {
    const captured = [];
    const origError = console.error;
    console.error = (...args) => captured.push(args.join(' '));
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_meta', type: 'message', role: 'assistant', stop_reason: 'end_turn',
                content: [
                    { type: 'text', text: 'CANARY_PROSE' },
                    { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'CANARY_CMD' } },
                ],
                usage: { input_tokens: 4, output_tokens: 2 },
            }));
        });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
    });
    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(response.status, 200);
        await response.json();
        const resp = captured.filter(l => l.startsWith('[context-resp]'));
        assert.equal(resp.length, 1);
        assert.match(resp[0], /blocks=text,tool_use tool_uses=Bash server_tools=- ts_results=0 tool_refs=0 stop=end_turn/);
        assert.ok(!resp[0].includes('CANARY_PROSE') && !resp[0].includes('CANARY_CMD'));
    } finally {
        console.error = origError;
        proxy.close();
        closeServer(upstream);
    }
});

test('proxy accumulates block metadata over SSE streams', async () => {
    const captured = [];
    const origError = console.error;
    console.error = (...args) => captured.push(args.join(' '));
    const sse = (id, obj) => `event: ${id}\ndata: ${JSON.stringify(obj)}\n\n`;
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end([
                sse('message_start', { type: 'message_start', message: { id: 'm', usage: { input_tokens: 6, output_tokens: 0 } } }),
                sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'mcp__sentry__list' } }),
                sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
                sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
                sse('message_stop', { type: 'message_stop' }),
            ].join(''));
        });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
    });
    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
            body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], stream: true }),
        });
        assert.equal(response.status, 200);
        await response.text();
        await new Promise(r => setTimeout(r, 100));
        const resp = captured.filter(l => l.startsWith('[context-resp]'));
        assert.equal(resp.length, 1);
        assert.match(resp[0], /server_tools=mcp__sentry__list/);
        assert.match(resp[0], /stop=tool_use/);
        assert.match(resp[0], /in=6 out=5/);
    } finally {
        console.error = origError;
        proxy.close();
        closeServer(upstream);
    }
});

test('gracefulShutdown waits for in-flight requests then closes', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const upstream = createServer((req, res) => {
        req.resume();
        req.on('end', async () => {
            await gate;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'm', type: 'message', role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 1, output_tokens: 1 },
            }));
        });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
    });
    try {
        const pending = fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
        });
        await new Promise(r => setTimeout(r, 150));
        assert.equal(proxy.getInFlightCount(), 1);
        const t0 = Date.now();
        const shutdown = proxy.gracefulShutdown(2000);
        await new Promise(r => setTimeout(r, 150));
        release();
        const resp = await pending;
        assert.equal(resp.status, 200);
        await resp.json();
        await shutdown;
        assert.ok(Date.now() - t0 < 2000, 'shutdown resolves after drain, not at timeout');
        assert.equal(proxy.getInFlightCount(), 0);
    } finally {
        release?.();
        proxy.close();
        closeServer(upstream);
    }
});

test('gracefulShutdown times out instead of hanging on stuck upstreams', async () => {
    const upstream = createServer((req) => { req.resume(); /* never responds */ });
    const upstreamPort = await listen(upstream);
    const proxy = await startModelProxy({
        targetUrl: `http://127.0.0.1:${upstreamPort}/api/v1`,
        apiKey: 'test-key',
        startPort: 0,
        upstreamRequest: httpRequest,
    });
    try {
        fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 150));
        const t0 = Date.now();
        await proxy.gracefulShutdown(300);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 2000, `bounded wait, took ${elapsed}ms`);
    } finally {
        proxy.close();
        closeServer(upstream);
    }
});

test('signal handlers are installed once per process', () => {
    const before = process.listenerCount('SIGTERM');
    assert.ok(before >= 1, 'proxy registers SIGTERM handling');
    assert.ok(process.listenerCount('SIGINT') >= 1, 'proxy registers SIGINT handling');
});

test('DeepSeek keeps reasoning controls, history and native tools', () => {
    const body = {
        thinking: { type: 'adaptive', budget_tokens: 2048 },
        output_config: { effort: 'ultra', format: { type: 'json_schema' } },
        context_management: {},
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'history', signature: 'sig' }] }],
    };
    const tools = structuredClone(body.tools);
    const messages = structuredClone(body.messages);
    prepareBackendOptions(body, true);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.deepEqual(body.output_config, { effort: 'max' });
    assert.deepEqual(body.tools, tools);
    assert.deepEqual(body.messages, messages);
    assert.equal(body.context_management, undefined);
    prepareBackendOptions(body, false);
    assert.equal(body.thinking, undefined);
});

test('token estimate includes system, tools and UTF-8 input', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const base = estimateInputTokens(body);
    assert.ok(estimateInputTokens({ ...body, system: 'x'.repeat(3000) }) >= base + 1000);
    assert.ok(estimateInputTokens({ ...body, tools: [{ name: 'test', description: 'x'.repeat(3000) }] }) >= base + 1000);
    assert.ok(estimateInputTokens({ messages: [{ role: 'user', content: '中文'.repeat(100) }] }) > base);
});

test('DeepSeek proxy forwards native web tools and their results and prices cached tokens', async () => {
    let received;
    const content = [
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'test' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
        { type: 'text', text: 'result' },
    ];
    const upstream = createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            received = JSON.parse(Buffer.concat(chunks));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'message', id: 'msg_search', model: 'deepseek-flash', content,
                usage: { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000 } }));
        });
    });
    const port = await listen(upstream);
    const proxy = await startModelProxy({ targetUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: 'test', defaultMode: 'ds',
        backends: { deepseek: { url: `http://127.0.0.1:${port}/anthropic`, apiKey: 'test' } }, startPort: 0, upstreamRequest: httpRequest });
    try {
        const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
                max_tokens: 100, tools, messages: [{ role: 'user', content: 'search the web' }] }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).content, content);
        assert.deepEqual(received.tools, tools);
        assert.deepEqual(received.thinking, { type: 'enabled' });
        assert.deepEqual(received.output_config, { effort: 'high' });
        const costs = await fetch(`http://127.0.0.1:${proxy.port}/_proxy/cost`).then(r => r.json());
        assert.equal(costs.backends.deepseek.cost, 1.506);
        assert.equal(costs.backends.deepseek.cache_read_input_tokens, 1000000);
        assert.equal(costs.backends.deepseek.cost_basis, 'peak_token_estimate_excludes_search_fetch');
    } finally {
        proxy.close();
        closeServer(upstream);
    }
});
