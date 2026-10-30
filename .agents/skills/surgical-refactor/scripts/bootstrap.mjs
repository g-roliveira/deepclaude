import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tooling = join(skill, 'tooling');
const root = resolve(process.argv[2] || process.cwd());
if (!existsSync(join(root, 'package.json'))) {
  throw new Error('Bootstrap JS requires a project package.json. Run discovery first; use native tools for other languages.');
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!pkg.type && !existsSync(join(root, 'proxy'))) console.warn('Check the discovered JS/TS scope before using the example configs.');
function run(command, args, cwd = tooling) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, SEMGREP_SEND_METRICS: 'off' } });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message || ''}`);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 12) || major === 24 || major >= 26)) throw new Error('This pinned tooling requires Node 22.12+, 24.x or >=26; runtime requirements are unchanged.');
run('npm', [existsSync(join(tooling, 'package-lock.json')) ? 'ci' : 'install', '--no-fund', '--no-audit']);
const localSemgrep = join(tooling, '.venv', 'bin/semgrep');
const existing = spawnSync('semgrep', ['--version'], { encoding: 'utf8' });
const pinnedSemgrep = readFileSync(join(tooling, 'requirements.in'), 'utf8').match(/^semgrep==([^\s]+)/m)?.[1];
const existingSemgrep = existing.stdout?.match(/\b\d+\.\d+\.\d+\b/)?.[0];
if (existing.status === 0 && existingSemgrep === pinnedSemgrep && !existsSync(localSemgrep)) {
  console.log(`Reusing existing Semgrep ${existing.stdout.trim()}; no new MCP or global installation.`);
} else {
  if (!existsSync(localSemgrep)) run('uv', ['venv', '--python', '3.12', join(tooling, '.venv')]);
  const lock = join(tooling, 'requirements.txt');
  if (!existsSync(lock)) run('uv', ['pip', 'compile', 'requirements.in', '--python-version', '3.12', '--generate-hashes', '--quiet', '--output-file', lock]);
  const python = join(tooling, '.venv', 'bin/python');
  run('uv', ['pip', 'sync', '--python', python, lock]);
}
console.log(`Project tooling ready at ${realpathSync(tooling)}. No runtime dependencies or MCP servers added.`);
