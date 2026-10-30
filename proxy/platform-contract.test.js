import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const skill = '.agents/skills/surgical-refactor';

function filesUnder(path) {
    if (!existsSync(path) || path === join(root, '.surgical-refactor/artifacts')) return [];
    if (lstatSync(path).isSymbolicLink()) return [path];
    if (!lstatSync(path).isDirectory()) return [path];
    return readdirSync(path).filter(name => !['node_modules', '.venv', '.git', '.deepclaude'].includes(name))
        .flatMap(name => filesUnder(join(path, name)));
}

test('owned source and automation contain no native Windows launchers', () => {
    const files = filesUnder(root);
    assert.deepEqual(files.filter(file => /\.(?:ps1|psm1|psd1|bat|cmd|exe)$/i.test(file)), []);
    assert.equal(existsSync(join(root, 'deepclaude.ps1')), false);
});

test('tooling has only POSIX executable paths and active checks require no PowerShell', () => {
    for (const file of ['bootstrap.mjs', 'refactor.mjs']) {
        const source = readFileSync(join(root, skill, 'scripts', file), 'utf8');
        assert.doesNotMatch(source, /win32|\.cmd\b|Scripts\/[^'"\s]*\.exe/);
    }
    for (const file of ['deepclaude.sh', 'proxy/model-proxy.js', 'proxy/start-proxy.js']) {
        assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /\b(?:pwsh|powershell|win32)\b/i);
    }
    const config = JSON.parse(readFileSync(join(root, '.surgical-refactor/config.json'), 'utf8'));
    assert.equal(config.policy.mode, 'enforce');
    assert.ok(config.policy.forbiddenPaths.includes('deepclaude.ps1'));
    assert.equal(config.entryPoints.includes('deepclaude.ps1'), false);
    for (const check of config.checks) assert.doesNotMatch(check.command.join(' '), /pwsh|powershell|deepclaude\.ps1/i);
    const workflow = readFileSync(join(root, '.github/workflows/surgical-refactor.yml'), 'utf8');
    assert.doesNotMatch(workflow, /(?:shell:\s*|run:\s*)(?:pwsh|powershell)/i);
    assert.match(workflow, /npm run refactor:verify/);
});

test('Bash CLI still exposes help and supported provider flags without starting a session', () => {
    const result = spawnSync('bash', ['deepclaude.sh', '--help'], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--backend/);
    assert.match(result.stdout, /ds\|or\|op\|mm\|fw\|anthropic/);
    assert.match(result.stdout, /--remote/);
    assert.match(result.stdout, /--model/);
    assert.doesNotMatch(result.stdout, /Starting model proxy/);
});
