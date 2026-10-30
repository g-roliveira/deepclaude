import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { startModelProxy, prepareDeepSeekVisionRequest, prepareBackendOptions } from './model-proxy.js';

const png = { type: 'image', source: { type: 'base64', media_type: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } };
const message = (text = 'ok', usage = { input_tokens: 10, output_tokens: 1 }) => ({
    type: 'message', id: 'msg_test', role: 'assistant', model: 'deepseek-flash',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage,
});

async function fixture(run, handler) {
    const seen = [];
    const upstream = createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            let body;
            try { body = JSON.parse(raw); } catch { body = raw; }
            const call = { path: req.url, method: req.method, headers: req.headers, body, raw };
            seen.push(call);
            if (handler) handler(call, res, seen.length);
            else {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(message()));
            }
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${upstream.address().port}/anthropic`;
    const proxy = await startModelProxy({ targetUrl: url, apiKey: 'backend-key', defaultMode: 'ds',
        backends: { deepseek: { url, apiKey: 'backend-key' } }, startPort: 0,
        // Contract tests must never contact a real provider, including fallback.
        upstreamRequest: (options, callback) => {
            assert.equal(options.hostname, '127.0.0.1', 'unexpected external route');
            return httpRequest(options, callback);
        } });
    const base = `http://127.0.0.1:${proxy.port}`;
    const post = (body, path = '/v1/messages', headers = {}) => fetch(base + path, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    try { await run({ base, seen, post }); }
    finally {
        await proxy.gracefulShutdown(500);
        upstream.closeAllConnections();
        await new Promise(resolve => upstream.close(resolve));
    }
}

test('ordinary short or summarize requests and JSON text reach the model, never a title mock', async () => {
    await fixture(async ({ seen, post }) => {
        for (const text of ['Give a short answer in JSON', 'Summarize the result in JSON', 'Extract the title as JSON']) {
            const response = await post({ model: 'deepseek-flash', max_tokens: 128, messages: [{ role: 'user', content: text }] });
            assert.equal(response.status, 200);
            const json = await response.json();
            assert.equal(json.content[0].text, '{"ok":true}');
        }
        assert.equal(seen.length, 3);
    }, (_call, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(message('{"ok":true}')));
    });
});

test('Files API operations use DeepSeek auth, beta, paths and unmodified multipart', async () => {
    await fixture(async ({ base, seen }) => {
        const multipart = '--fixture\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n';
        const upload = Buffer.concat([Buffer.from(multipart), Buffer.from(png.source.data, 'base64'), Buffer.from('\r\n--fixture--\r\n')]);
        for (const [method, path, body] of [
            ['POST', '/v1/files', upload], ['GET', '/v1/files?limit=20&after_id=file-api-old'],
            ['GET', '/v1/files/file-api-test'], ['DELETE', '/v1/files/file-api-test'],
        ]) {
            const response = await fetch(base + path, { method, body,
                headers: { authorization: 'Bearer client-key', 'x-api-key': 'client-key',
                    'anthropic-beta': 'files-api-2025-04-14,other-beta', 'content-type': 'multipart/form-data; boundary=fixture' } });
            assert.equal(response.status, 200);
            await response.json();
            const call = seen.at(-1);
            assert.equal(call.path, '/anthropic' + path);
            assert.equal(call.method, method);
            assert.equal(call.headers['x-api-key'], 'backend-key');
            assert.equal(call.headers.authorization, undefined);
            assert.equal(call.headers['anthropic-beta'], 'files-api-2025-04-14,other-beta');
            if (body) assert.deepEqual(call.raw, body);
        }
    }, (_call, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"file-api-test","type":"file"}'); });
});

test('unsupported API families fail locally instead of reaching Anthropic', async () => {
    await fixture(async ({ post, seen }) => {
        for (const path of ['/v1/responses', '/responses', '/chat/completions', '/v1/chat/completions',
            '/beta/chat/completions', '/beta/completions', '/v1/completions', '/v1/tools/search', '/v1/tools/fetch']) {
            const response = await post({ model: 'deepseek-flash' }, path);
            assert.equal(response.status, 501, path);
            assert.match((await response.json()).error.message, /directly/);
        }
        assert.equal(seen.length, 0);
    });
});

test('vision HTTP route preserves a real PNG nested in tool_result and deduplicates file beta', async () => {
    await fixture(async ({ post, seen }) => {
        const current = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_1', content: [png] }] };
        const response = await post({ model: 'claude-sonnet-5', max_tokens: 512,
            messages: [{ role: 'user', content: [png] }, current] }, '/v1/messages?beta=true',
        { 'anthropic-beta': 'files-api-2025-04-14,other-beta' });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).model, 'claude-sonnet-5');
        assert.equal(seen[0].body.model, 'deepseek-flash');
        assert.deepEqual(seen[0].body.messages[1], current);
        assert.equal(seen[0].body.messages[0].content[0].type, 'text');
        assert.equal(seen[0].path, '/anthropic/v1/messages?beta=true');
        assert.equal(seen[0].headers['anthropic-beta'], 'files-api-2025-04-14,other-beta');
    });
});

test('vision sources accept URL/file references and reject malformed input before upstream', async () => {
    await fixture(async ({ post, seen }) => {
        for (const source of [{ type: 'url', url: 'https://example.com/p.png' }, { type: 'file', file_id: 'file-api-test' }]) {
            const response = await post({ model: 'deepseek-flash', max_tokens: 512,
                messages: [{ role: 'user', content: [{ type: 'image', source }] }] });
            assert.equal(response.status, 200);
            await response.json();
            assert.deepEqual(seen.at(-1).body.messages[0].content[0].source, source);
        }
        const previous = seen.length;
        for (const source of [{ type: 'file' }, { type: 'file', file_id: 'not-a-deepseek-file' },
            { type: 'url', url: 'file:///private.png' }, { type: 'url', url: 'https://example.com/' + 'a'.repeat(8192) },
            { type: 'base64', media_type: 'image/png', data: 'broken' },
            { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' }]) {
            const response = await post({ model: 'deepseek-flash', max_tokens: 512,
                messages: [{ role: 'user', content: [{ type: 'image', source }] }] });
            assert.equal(response.status, 400);
            await response.json();
        }
        assert.equal(seen.length, previous);
    });
});

test('vision signature checks recognize JPEG PNG GIF WebP (not full image decoding)', () => {
    for (const [media_type, bytes] of [
        ['image/jpeg', Buffer.from([255, 216, 255, 224])], ['image/png', Buffer.from(png.source.data, 'base64')],
        ['image/gif', Buffer.from('GIF89a')], ['image/webp', Buffer.from('RIFF0000WEBP')],
    ]) {
        const body = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type, data: bytes.toString('base64') } }] }] };
        assert.doesNotThrow(() => prepareDeepSeekVisionRequest(body));
    }
});

test('vision enforces 600 images per request and 32 MiB per inline image', () => {
    const request = content => ({ messages: [{ role: 'user', content }] });
    assert.throws(() => prepareDeepSeekVisionRequest(request(Array(601).fill(png))), /600/);
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
    Buffer.from(png.source.data, 'base64').copy(oversized);
    assert.throws(() => prepareDeepSeekVisionRequest(request([{ type: 'image', source: {
        type: 'base64', media_type: 'image/png', data: oversized.toString('base64'),
    } }])), /32 MiB/);
});

test('every documented effort maps correctly and disabled thinking stays disabled', () => {
    for (const [requested, expected] of Object.entries({ minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max', ultra: 'max' })) {
        const body = { thinking: { type: 'disabled' }, output_config: { effort: requested } };
        prepareBackendOptions(body);
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.deepEqual(body.output_config, { effort: expected });
    }
});

test('multi-turn tool loop retains reasoning, ids, tools, system and metadata prefix', async () => {
    await fixture(async ({ post, seen }) => {
        const initial = { model: 'deepseek-flash', max_tokens: 512,
            system: [{ type: 'text', text: 'Stable instructions', cache_control: { type: 'ephemeral' } }],
            metadata: { user_id: 'test-user' }, thinking: { type: 'enabled', budget_tokens: 1024 },
            tools: [{ name: 'weather', input_schema: { type: 'object', properties: {} } }],
            tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: 'weather?' }] };
        const first = await (await post(initial)).json();
        const continued = [...initial.messages, { role: 'assistant', content: first.content },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'weather_1', content: '24C' }] }];
        const second = await (await post({ ...initial, messages: continued })).json();
        assert.equal(second.content[0].text, '24C');
        assert.deepEqual(seen[1].body.messages, continued);
        for (const key of ['system', 'metadata', 'tools', 'tool_choice']) assert.deepEqual(seen[1].body[key], seen[0].body[key]);
        assert.deepEqual(seen[1].body.thinking, { type: 'enabled' });
    }, (_call, res, turn) => {
        const result = message('24C');
        if (turn === 1) { result.content = [
            { type: 'thinking', thinking: 'Need weather', signature: 'deepseek-signature' },
            { type: 'tool_use', id: 'weather_1', name: 'weather', input: {} },
        ]; result.stop_reason = 'tool_use'; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    });
});

test('SSE preserves thinking signatures, tool JSON, native search and cache usage', async () => {
    const events = [
        { type: 'message_start', message: { ...message(), content: [], usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Previsão em Salvador: 中文 🌧️' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'weather', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Salvador"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', name: 'web_search', id: 's1', input: {} } },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [] } },
        { type: 'content_block_stop', index: 3 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20, cache_read_input_tokens: 100 } },
        { type: 'message_stop' },
    ];
    await fixture(async ({ post, base }) => {
        const response = await post({ model: 'deepseek-flash', max_tokens: 512, stream: true, messages: [{ role: 'user', content: 'weather?' }] });
        const output = await response.text();
        const actual = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        assert.deepEqual(actual, events);
        const summary = await (await fetch(base + '/_proxy/cost')).json();
        assert.equal(summary.backends.deepseek.requests, 1);
        assert.equal(summary.backends.deepseek.cache_read_input_tokens, 100);
    }, (_call, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const wire = Buffer.from(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
        const split = wire.indexOf(Buffer.from('中文')) + 1;
        res.write(wire.subarray(0, split));
        setTimeout(() => res.end(wire.subarray(split)), 10);
    });
});

test('count_tokens rejects invalid JSON rather than reporting zero and estimates full input', async () => {
    await fixture(async ({ post, base }) => {
        const small = await (await post({ messages: [{ role: 'user', content: 'hello' }] }, '/v1/messages/count_tokens')).json();
        const large = await (await post({ system: 'x'.repeat(6000), messages: [{ role: 'user', content: 'hello' }] }, '/v1/messages/count_tokens')).json();
        assert.ok(large.input_tokens > small.input_tokens + 1900);
        const invalid = await fetch(base + '/v1/messages/count_tokens', { method: 'POST', body: '{broken' });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).type, 'error');
    });
});

test('Bash retains documented compaction headroom', () => {
    const bash = readFileSync(new URL('../deepclaude.sh', import.meta.url), 'utf8');
    assert.match(bash, /CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432/);
    assert.doesNotMatch(bash, /CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000/);
    assert.doesNotMatch(bash, /900000/);
});

test('SSE accepts CRLF and injects absent usage without stale content-length', async () => {
    await fixture(async ({ post }) => {
        const response = await post({ model: 'deepseek-flash', max_tokens: 512, stream: true,
            messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(response.headers.get('content-length'), null);
        const events = (await response.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
        assert.deepEqual(events[0].message.usage, { input_tokens: 0, output_tokens: 0 });
        assert.deepEqual(events[1].usage, { output_tokens: 0 });
        assert.equal(events.at(-1).type, 'message_stop');
    }, (_call, res) => {
        const wire = [
            { type: 'message_start', message: { id: 'm', type: 'message', content: [] } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            { type: 'message_stop' },
        ].map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(wire) });
        res.end(wire);
    });
});

test('SSE final input usage supersedes initial usage and partial deltas retain output count', async () => {
    await fixture(async ({ post, base }) => {
        await (await post({ model: 'deepseek-flash', max_tokens: 512, stream: true,
            messages: [{ role: 'user', content: 'hello' }] })).text();
        const usage = (await (await fetch(base + '/_proxy/cost')).json()).backends.deepseek;
        assert.equal(usage.input_tokens, 12);
        assert.equal(usage.output_tokens, 20);
        assert.equal(usage.cache_read_input_tokens, 100);
    }, (_call, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
            { type: 'message_start', message: { id: 'm', usage: { input_tokens: 10, output_tokens: 0 } } },
            { type: 'message_delta', delta: {}, usage: { output_tokens: 20 } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 12, cache_read_input_tokens: 100 } },
            { type: 'message_stop' },
        ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
});

test('tool_choice variants and parallel tool results retain their names and ids', async () => {
    await fixture(async ({ post, seen }) => {
        for (const tool_choice of [{ type: 'none' }, { type: 'auto' }, { type: 'any' }, { type: 'tool', name: 'a' }]) {
            const messages = [
                { role: 'user', content: 'read both' },
                { role: 'assistant', content: [
                    { type: 'tool_use', id: 'a1', name: 'a', input: { n: 1 } },
                    { type: 'tool_use', id: 'a2', name: 'a', input: { n: 2 } },
                ] },
                { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'a1', content: 'one' },
                    { type: 'tool_result', tool_use_id: 'a2', content: 'two', is_error: true },
                ] },
            ];
            await (await post({ model: 'deepseek-flash', max_tokens: 512, tool_choice,
                tools: [{ name: 'a', input_schema: { type: 'object', properties: { n: { type: 'integer' } } } }], messages })).json();
            assert.deepEqual(seen.at(-1).body.tool_choice, tool_choice);
            assert.deepEqual(seen.at(-1).body.messages, messages);
        }
    });
});

test('provider validation, balance and rate-limit errors keep status, body and retry-after', async () => {
    await fixture(async ({ post }) => {
        for (const status of [400, 402, 429, 503]) {
            const response = await post({ model: 'deepseek-flash', max_tokens: 512, messages: [{ role: 'user', content: String(status) }] });
            assert.equal(response.status, status);
            assert.equal(response.headers.get('retry-after'), '10');
            assert.deepEqual(await response.json(), { type: 'error', error: { type: 'api_error', message: `fixture ${status}` } });
        }
    }, (call, res) => {
        const status = Number(call.body.messages[0].content);
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '10' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `fixture ${status}` } }));
    });
});

test('Messages and token count reject bodies over 48 MiB without forwarding', async () => {
    await fixture(async ({ base, seen }) => {
        const body = Buffer.alloc(48 * 1024 * 1024 + 1, 32);
        for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
            const response = await fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
            assert.equal(response.status, 413);
            assert.match((await response.json()).error.message, /48 MiB/);
        }
        assert.equal(seen.length, 0);
    });
});
