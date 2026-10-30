import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startModelProxy } from './model-proxy.js';

const removed = ['openrouter', 'minimax', 'fireworks', 'or', 'op', 'mm', 'fw'];
const base = { targetUrl: 'https://api.deepseek.com/anthropic', apiKey: 'test-only', startPort: 0 };

async function rejectsStartup(config, pattern) {
    let started;
    try {
        await assert.rejects(startModelProxy(config).then(proxy => { started = proxy; return proxy; }), pattern);
    } finally {
        started?.close();
    }
}

test('removed providers and aliases cannot initialize the proxy or its registry', async () => {
    for (const name of [...removed, 'unknown']) {
        await rejectsStartup({ ...base, defaultMode: name }, /Unsupported backend/);
        await rejectsStartup({ ...base, backends: { [name]: { url: base.targetUrl, apiKey: 'test' } } }, /Unsupported backend configuration/);
    }
    await rejectsStartup({ ...base, defaultMode: 'deepseek', backends: { deepseek: { url: base.targetUrl, apiKey: null } } }, /API key not set/);
    await rejectsStartup({ ...base, defaultMode: 'deepseek', apiKey: null }, /API key not set/);
});

test('initial provider selection normalizes ds and supports Anthropic without a DeepSeek key', async () => {
    for (const name of ['ds', 'deepseek', 'anthropic']) {
        const proxy = await startModelProxy({ ...base, defaultMode: name, ...(name === 'anthropic' ? { apiKey: null } : {}) });
        try {
            const status = await fetch(`http://127.0.0.1:${proxy.port}/_proxy/status`);
            assert.equal((await status.json()).mode, name === 'ds' ? 'deepseek' : name);
        } finally {
            proxy.close();
        }
    }
});

test('DeepSeek rejects a missing key on switch without changing Anthropic state', async t => {
    const proxy = await startModelProxy({ ...base, apiKey: null, defaultMode: 'anthropic', backends: { deepseek: { url: base.targetUrl, apiKey: null } } });
    t.after(() => proxy.close());
    assert.match(proxy.switchMode('deepseek').error, /API key not set/);
    const status = await fetch(`http://127.0.0.1:${proxy.port}/_proxy/status`);
    assert.equal((await status.json()).mode, 'anthropic');
});

test('live switching preserves DeepSeek/Anthropic credentials, reasoning and bridge routing', async t => {
    const received = [];
    const upstream = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        received.push({ headers: req.headers, url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ type: 'message', model: 'native', content: [{ type: 'redacted_thinking', data: 'opaque' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const destinations = [];
    const proxy = await startModelProxy({
        ...base, defaultMode: 'anthropic',
        backends: { deepseek: { url: base.targetUrl, apiKey: 'deepseek-only' } },
        upstreamRequest(options, callback) {
            destinations.push({ host: options.hostname, path: options.path });
            return request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }, callback);
        },
    });
    t.after(() => proxy.close());
    const endpoint = `http://127.0.0.1:${proxy.port}`;
    const send = async (path = '/v1/messages?beta=true') => {
        const response = await fetch(endpoint + path, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer managed-auth' },
            body: JSON.stringify({ model: 'claude-opus-5', thinking: { type: 'adaptive' }, output_config: { effort: 'max' },
                messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'prior', signature: 'signed' }, { type: 'text', text: 'answer' }] }, { role: 'user', content: 'continue' }] }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).content, [{ type: 'redacted_thinking', data: 'opaque' }]);
    };
    await send();
    assert.equal(received[0].headers.authorization, 'Bearer managed-auth');
    assert.equal(received[0].headers['x-api-key'], undefined);
    assert.equal(received[0].body.model, 'claude-opus-5');
    assert.deepEqual(received[0].body.thinking, { type: 'adaptive' });
    assert.equal(received[0].body.messages[0].content[0].signature, 'signed');
    assert.deepEqual(destinations[0], { host: 'api.anthropic.com', path: '/v1/messages?beta=true' });

    for (const name of [...removed, 'deepseek-extra', 'anthropic-extra']) {
        const response = await fetch(endpoint + '/_proxy/mode', { method: 'POST', body: `backend=${name}` });
        assert.equal(response.status, 400, name);
        assert.match((await response.json()).error, /Unknown backend/);
        assert.equal((await (await fetch(endpoint + '/_proxy/status')).json()).mode, 'anthropic');
    }
    assert.equal(received.length, 1, 'rejected switches make no upstream requests');
    assert.deepEqual(proxy.switchMode('ds'), { mode: 'deepseek', previous: 'anthropic' });
    await send();
    assert.equal(received[1].headers.authorization, undefined);
    assert.equal(received[1].headers['x-api-key'], 'deepseek-only');
    assert.equal(received[1].body.model, 'deepseek-flash');
    assert.deepEqual(received[1].body.thinking, { type: 'enabled' });
    assert.equal(received[1].body.messages[0].content[0].signature, 'signed');
    assert.deepEqual(destinations[1], { host: 'api.deepseek.com', path: '/anthropic/v1/messages?beta=true' });
    await send('/bridge-test');
    assert.equal(destinations[2].host, 'api.anthropic.com');
    assert.equal(received[2].headers.authorization, 'Bearer managed-auth');
    assert.equal(received[2].headers['x-api-key'], undefined);
    assert.deepEqual(proxy.switchMode('anthropic'), { mode: 'anthropic', previous: 'deepseek' });
    await send();
    assert.equal(received[3].headers.authorization, 'Bearer managed-auth');
    assert.equal(received[3].headers['x-api-key'], undefined);
    assert.deepEqual(received[3].body.messages[0].content, [{ type: 'text', text: 'answer' }], 'foreign signed thinking is removed on switch');
});

test('DeepSeek and Anthropic streaming preserve complete redacted thinking blocks', async t => {
    const events = [
        { type: 'message_start', message: { id: 'msg_redacted', type: 'message', role: 'assistant', model: 'native', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque-signed-content' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const wire = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const upstream = createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire); });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const proxy = await startModelProxy({ ...base, defaultMode: 'deepseek', backends: { deepseek: { url: base.targetUrl, apiKey: 'test-only' } },
        upstreamRequest: (options, callback) => request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }, callback) });
    t.after(() => proxy.close());
    for (const mode of ['deepseek', 'anthropic']) {
        proxy.switchMode(mode);
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
        assert.equal(response.status, 200);
        const data = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        assert.deepEqual(data, events, mode);
    }
});

function launcherFixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'deepclaude-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    copyFileSync('deepclaude.sh', join(dir, 'deepclaude.sh'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/claude'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE/args"\nenv > "$CAPTURE/env"\nexit "${CLAUDE_TEST_EXIT:-0}"\n', { mode: 0o755 });
    writeFileSync(join(dir, 'bin/node'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE/proxy-args"\necho 43210\n', { mode: 0o755 });
    writeFileSync(join(dir, 'bin/curl'), '#!/bin/bash\necho "unexpected network call" >&2\nexit 91\n', { mode: 0o755 });
    const env = { PATH: `${dir}/bin:/usr/bin:/bin`, HOME: dir, CAPTURE: dir, DEEPSEEK_API_KEY: 'test-only' };
    return { dir, run: (args, extra = {}) => spawnSync('bash', [join(dir, 'deepclaude.sh'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000 }) };
}

test('Bash rejects retired backend selectors before launching or contacting a proxy', t => {
    const { run } = launcherFixture(t);
    for (const name of removed) {
        for (const args of [['--backend', name], ['--switch', name]]) {
            const result = run(args);
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /Unknown backend/);
            assert.doesNotMatch(result.stderr, /unexpected network/);
        }
        assert.match(run([], { CHEAPCLAUDE_DEFAULT_BACKEND: name }).stderr, /Unknown backend/);
    }
});

test('standalone proxy rejects retired modes without binding a port or accepting old environment overrides', () => {
    for (const name of removed) {
        const result = spawnSync(process.execPath, ['proxy/start-proxy.js', '--mode', name, '--port', '0'], {
            encoding: 'utf8', timeout: 5000,
            env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'test-only', CHEAPCLAUDE_MODEL: 'retired-model', OPENROUTER_API_KEY: 'unused', FIREWORKS_API_KEY: 'unused' },
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Unsupported backend/);
        assert.doesNotMatch(result.stdout + result.stderr, /Listening on|Proxy on/);
    }
});

test('proxy CLI positional and environment launches register only DeepSeek and print a clean port', t => {
    const dir = mkdtempSync(join(tmpdir(), 'deepclaude-proxy-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    copyFileSync('proxy/start-proxy.js', join(dir, 'start-proxy.mjs'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'model-proxy.js'), `import {writeFileSync} from 'node:fs';
export async function startModelProxy(options) {
    writeFileSync(process.env.CAPTURE, JSON.stringify(options));
    return {port: 43210};
}`);
    for (const positional of [true, false]) {
        const capture = join(dir, 'captured.json');
        const result = spawnSync(process.execPath, [join(dir, 'start-proxy.mjs'), ...(positional ? [base.targetUrl, 'test-only', 'ds'] : [])], {
            env: { PATH: process.env.PATH, CAPTURE: capture, DEEPSEEK_API_KEY: 'test-only',
                CHEAPCLAUDE_TARGET_URL: base.targetUrl, CHEAPCLAUDE_API_KEY: 'test-only', CHEAPCLAUDE_DEFAULT_MODE: 'ds',
                CHEAPCLAUDE_MODEL: 'must-not-route', OPENROUTER_API_KEY: 'unused', FIREWORKS_API_KEY: 'unused' },
            encoding: 'utf8', timeout: 5000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, '43210\n');
        assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
            targetUrl: base.targetUrl, apiKey: 'test-only', defaultMode: 'ds',
            backends: { deepseek: { url: base.targetUrl, apiKey: 'test-only' } },
        });
    }
});

test('Anthropic launch and remote-control return without falling through to a proxy', t => {
    const { dir, run } = launcherFixture(t);
    for (const remote of [false, true]) {
        const result = run(['--backend', 'anthropic', ...(remote ? ['--remote'] : []), '--', '--resume', 'session-id']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(dir, 'args'), 'utf8'), `${remote ? 'remote-control\n' : ''}--resume\nsession-id\n`);
        assert.doesNotMatch(result.stdout, /Starting model proxy|Proxy on/);
    }
    assert.equal(run(['-b', 'anthropic'], { CLAUDE_TEST_EXIT: '7' }).status, 7);
});

test('DeepSeek launcher preserves model tiers, headroom, passthrough and auth isolation', t => {
    const { dir, run } = launcherFixture(t);
    for (const backend of ['ds', 'deepseek']) {
        const result = run(['-b', backend, '--effort', 'max', '--', '--model', 'deepseek-flash', '--resume', 'id']);
        assert.equal(result.status, 0, result.stderr);
        const env = readFileSync(join(dir, 'env'), 'utf8');
        assert.match(env, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:43210/);
        assert.match(env, /ANTHROPIC_API_KEY=test-only/);
        assert.doesNotMatch(env, /ANTHROPIC_AUTH_TOKEN=/);
        for (const name of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
            assert.ok(env.includes(`${name}=deepseek-flash[1m]`));
        }
        assert.match(env, /CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432/);
        assert.match(env, /CLAUDE_CODE_EFFORT_LEVEL=max/);
        assert.equal(readFileSync(join(dir, 'args'), 'utf8'), '--model\ndeepseek-flash\n--resume\nid\n');
        assert.equal(readFileSync(join(dir, 'proxy-args'), 'utf8').split('\n').filter(Boolean).length, 4);
    }
    const remote = run(['--remote']);
    assert.equal(remote.status, 0, remote.stderr);
    assert.doesNotMatch(readFileSync(join(dir, 'env'), 'utf8'), /ANTHROPIC_(?:AUTH_TOKEN|API_KEY)=/);
    assert.equal(readFileSync(join(dir, 'args'), 'utf8'), 'remote-control\n');
});

test('standalone --mode and --port flags are parsed as flags, not positional credentials', async t => {
    const child = spawn(process.execPath, ['proxy/start-proxy.js', '--mode', 'ds', '--port', '0'], {
        env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'test-only' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    t.after(async () => { child.kill('SIGTERM'); await exited; });
    const output = await new Promise((resolve, reject) => {
        let stdout = '', stderr = '';
        const timer = setTimeout(() => reject(new Error(`startup timed out: ${stderr}`)), 5000);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('Proxy on :')) { clearTimeout(timer); resolve(stdout); } });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`proxy exited ${code}: ${stderr}`)); });
    });
    const port = output.match(/Proxy on :(\d+)/)[1];
    const response = await fetch(`http://127.0.0.1:${port}/_proxy/status`);
    assert.equal((await response.json()).mode, 'deepseek');
});
