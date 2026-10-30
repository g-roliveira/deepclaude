import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { astInventory, normalizeKnip, newFindings, policyViolations, scopedFiles, inside, run, redact, skillRoot } from '../scripts/refactor.mjs';

const requireTool = createRequire(join(skillRoot, 'tooling/package.json'));
const j = requireTool('jscodeshift');
const transform = requireTool('../examples/remove-unused-import.cjs');
const policy = extra => ({ mode: 'enforce', removedFeature: 'old-provider', forbiddenModules: [], forbiddenSymbols: [],
  forbiddenPaths: [], forbiddenText: [], allowedReferencePaths: [], ...extra });

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'surgical-refactor-test-'));
  mkdirSync(join(root, 'src'));
  try { return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('AST inventory finds static/dynamic imports, require, reexports and computed gaps', () => {
  const result = astInventory(`import { a } from 'old-provider';
    export { a } from 'shared'; export * from 'other';
    const x=import('plugin'); const y=import(name); const z=require('old-provider/adapter');
    export function publicApi(){}; export const value=1;`, 'src/main.js');
  assert.deepEqual(result.imports.map(i => i.specifier), ['old-provider', 'shared', 'other', 'plugin', null, 'old-provider/adapter']);
  assert.deepEqual(result.exports, ['a', 'publicApi', 'value']);
  assert.equal(result.unresolvedDynamic.length, 1);
});

test('guard catches reintroduced literal dynamic imports, reexports and package declarations', () => fixture(root => {
  writeFileSync(join(root, 'src/main.js'), `export * from 'old-provider'; const x=import('old-provider/adapter');`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'old-provider': '1.0.0' } }));
  const config = { sourceRoots: ['src'], configurationFiles: ['package.json'], policy: policy({ forbiddenModules: ['old-provider'] }) };
  const violations = policyViolations(root, config, [astInventory(`export * from 'old-provider'; const x=import('old-provider/adapter');`, 'src/main.js')]);
  assert.equal(violations.length, 3);
  assert.ok(violations.some(v => v.includes('forbidden dependency')));
}));

test('guard catches config registries, removed paths and forbidden identifiers', () => fixture(root => {
  writeFileSync(join(root, 'launcher.sh'), 'export OLD_PROVIDER_KEY=example');
  writeFileSync(join(root, 'src/old.js'), 'const OldAdapter = 1;');
  const config = { sourceRoots: ['src'], configurationFiles: ['launcher.sh'], policy: policy({ forbiddenSymbols: ['OldAdapter'],
    forbiddenPaths: ['src/old.js'], forbiddenText: [{ text: 'OLD_PROVIDER_KEY', paths: ['launcher.sh'] }] }) };
  const violations = policyViolations(root, config, [astInventory('const OldAdapter = 1;', 'src/old.js')]);
  assert.equal(violations.length, 3);
}));

test('policy exemptions are path-scoped and cannot suppress another production file', () => fixture(root => {
  const config = { sourceRoots: ['src'], configurationFiles: [], policy: policy({ forbiddenModules: ['old'], allowedReferencePaths: ['src/archive'] }) };
  const inventory = ['src/archive/fixture.js', 'src/production.js'].map(file => astInventory("import 'old';", file));
  const violations = policyViolations(root, config, inventory);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /production/);
}));

test('empty enforced removal cannot pretend to have an armed guard', () => fixture(root => {
  assert.throws(() => policyViolations(root, { sourceRoots: ['src'], configurationFiles: [], policy: policy({}) }, []), /at least one prohibition/);
}));

test('public exports and entry points are checked independently of dead-code reports', () => fixture(root => {
  const config = { sourceRoots: ['src'], configurationFiles: [], entryPoints: ['src/cli.js'],
    publicExports: { 'src/api.js': ['publicApi'] }, policy: policy({ forbiddenModules: ['old'] }) };
  const violations = policyViolations(root, config, [astInventory('export function other(){}', 'src/api.js')]);
  assert.equal(violations.length, 2);
}));

test('dead-code baseline identities ignore line churn but detect newly orphaned exports', () => {
  const before = normalizeKnip({ files: [], issues: [{ file: 'src/api.js', exports: [{ name: 'known', line: 1 }] }] });
  const after = normalizeKnip({ files: ['src/orphan.js'], issues: [{ file: 'src/api.js', exports: [{ name: 'known', line: 20 }, { name: 'new', line: 21 }] }] });
  assert.deepEqual(newFindings(before, after), ['knip:exports:src/api.js:new', 'knip:files:src/orphan.js']);
  assert.throws(() => normalizeKnip({ error: 'config invalid' }), /Unsupported/);
});

test('scope refuses directory escapes and does not traverse symlinks', () => fixture(root => {
  assert.throws(() => inside(root, '../outside'), /escapes/);
  symlinkSync(tmpdir(), join(root, 'src/external'));
  writeFileSync(join(root, 'src/main.js'), 'export const x=1;');
  assert.deepEqual(scopedFiles(root, { sourceRoots: ['src'], configurationFiles: [] }), ['src/main.js']);
}));

test('execution reports nonzero/missing commands and never evaluates shell syntax', () => fixture(root => {
  assert.equal(run([process.execPath, '-e', 'process.exit(7)'], { root }).exitCode, 7);
  assert.ok(run(['nonexistent-surgical-refactor-tool'], { root }).error);
  assert.throws(() => run('echo unsafe', { root }), /argv/);
  assert.equal(run([process.execPath, '-e', 'console.log(process.argv[1])', '$(do-not-run)'], { root }).stdout.trim(), '$(do-not-run)');
}));

test('known environment credentials are redacted from captured outputs', () => {
  process.env.SURGICAL_REFACTOR_TEST_SECRET = 'fake-secret-for-a-unit-test';
  try { assert.equal(redact('value fake-secret-for-a-unit-test'), 'value <REDACTED>'); }
  finally { delete process.env.SURGICAL_REFACTOR_TEST_SECRET; }
});

test('codemod removes only an unused explicit import; live/shared and side-effect imports stop', () => {
  const options = { module: 'old' };
  const result = transform({ source: "import { unused } from 'old'; import { keep } from 'shared'; keep();" }, { jscodeshift: j }, options);
  assert.doesNotMatch(result, /from 'old'/);
  assert.match(result, /from 'shared'/);
  assert.throws(() => transform({ source: "import { live } from 'old'; live();" }, { jscodeshift: j }, options), /Shared or live/);
  assert.throws(() => transform({ source: "import 'old';" }, { jscodeshift: j }, options), /Side-effect/);
});

test('invalid AST input is an explicit failure, not a clean inventory', () => {
  assert.throws(() => astInventory('export function {', 'src/broken.js'));
  const commonjs = astInventory('module.exports={ factory(){} }; exports.publicApi=()=>{}; module.exports.extra=1; new Function(code);', 'src/api.cjs');
  assert.deepEqual(commonjs.exports, ['default', 'extra', 'factory', 'publicApi']);
  assert.equal(commonjs.unresolvedDynamic[0].kind, 'dynamic-evaluation');
});

test('real Knip analysis detects a newly orphaned file in an isolated project', () => fixture(root => {
  writeFileSync(join(root, 'package.json'), '{"name":"isolated-fixture","private":true,"type":"module"}');
  writeFileSync(join(root, 'knip.json'), JSON.stringify({ entry: ['src/main.js'], project: ['src/**/*.js'], include: ['files', 'exports'] }));
  writeFileSync(join(root, 'src/main.js'), 'export const main=1;');
  const command = [join(skillRoot, 'tooling/node_modules/.bin/knip'), '--config', 'knip.json', '--reporter', 'json', '--no-progress'];
  const before = run(command, { root });
  assert.equal(before.exitCode, 0, before.stderr);
  writeFileSync(join(root, 'src/orphan.js'), 'export const orphan=1;');
  const after = run(command, { root });
  assert.equal(after.exitCode, 1, after.stderr);
  const additions = newFindings(normalizeKnip(JSON.parse(before.stdout)), normalizeKnip(JSON.parse(after.stdout)));
  assert.deepEqual(additions, ['knip:files:src/orphan.js']);
}));
