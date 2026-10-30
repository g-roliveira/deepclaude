import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tooling = join(skillRoot, 'tooling');
const requireTool = createRequire(join(tooling, 'package.json'));
const codeExtension = /\.[cm]?[jt]sx?$/;
const textExtension = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|sh|md)$/;

export function inside(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes project: ${path}`);
  return absolute;
}

export function scopedFiles(root, config) {
  const files = new Set();
  function visit(path) {
    const absolute = inside(root, path);
    if (!existsSync(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return; // never traverse into another project
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        if (!['node_modules', '.git', '.venv', 'artifacts'].includes(entry)) visit(join(path, entry));
      }
    } else if (textExtension.test(path)) files.add(path.split(sep).join('/'));
  }
  for (const path of [...config.sourceRoots, ...config.configurationFiles]) visit(path);
  return [...files].sort();
}

export function redact(text) {
  let result = String(text || '');
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|API_KEY|PASSWORD|SECRET)/i.test(key) && value && value.length >= 8) result = result.split(value).join('<REDACTED>');
  }
  return result;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function run(command, { root, output, name, timeout = 120000 } = {}) {
  if (!Array.isArray(command) || command.length === 0 || command.some(x => typeof x !== 'string')) throw new Error('Commands must be non-empty argv arrays; shell evaluation is disabled.');
  const start = Date.now();
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', timeout,
    maxBuffer: 32 * 1024 * 1024, env: { ...process.env, SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0' } });
  const stdout = redact(result.stdout);
  const stderr = redact(result.stderr);
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${name}.stdout.log`), stdout);
    writeFileSync(join(output, `${name}.stderr.log`), stderr);
  }
  return { name, command: command.map(redact), exitCode: result.status, durationMs: Date.now() - start,
    error: result.error?.message || null, stdout, stderr };
}

function parseJsonRun(result) {
  if (result.error || ![0, 1].includes(result.exitCode)) throw new Error(`${result.name} failed: ${result.error || result.stderr.slice(-1500)}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${result.name} did not produce valid JSON: ${result.stderr.slice(-1500)}`); }
}

export function astInventory(source, file = 'module.js') {
  const j = requireTool('jscodeshift').withParser(/\.[cm]?tsx?$/.test(file) ? 'tsx' : 'babylon');
  const ast = j(source);
  const imports = [], exports = [], identifiers = new Set();
  const value = node => typeof node?.value === 'string' ? node.value
    : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis.map(q => q.value.cooked).join('') : null;
  ast.find(j.Node).forEach(path => {
    const node = path.node;
    const line = node.loc?.start.line || null;
    if (node.type === 'Identifier') identifiers.add(node.name);
    if (node.type === 'ImportDeclaration') imports.push({ kind: 'import', specifier: value(node.source), line });
    if (node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
      if (node.source) imports.push({ kind: 'reexport', specifier: value(node.source), line });
      if (node.declaration?.id?.name) exports.push(node.declaration.id.name);
      for (const declaration of node.declaration?.declarations || []) if (declaration.id?.name) exports.push(declaration.id.name);
      for (const specifier of node.specifiers || []) if (specifier.exported?.name) exports.push(specifier.exported.name);
    }
    if (node.type === 'ExportDefaultDeclaration') exports.push('default');
    if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression') {
      const left = node.left;
      const property = left.computed ? value(left.property) : left.property?.name;
      if (left.object?.name === 'module' && property === 'exports') {
        exports.push('default');
        if (node.right.type === 'ObjectExpression') for (const field of node.right.properties) {
          const name = field.computed ? value(field.key) : field.key?.name || field.key?.value;
          if (typeof name === 'string') exports.push(name);
        }
      } else if (left.object?.name === 'exports' && property) exports.push(property);
      else if (left.object?.type === 'MemberExpression' && left.object.object?.name === 'module'
        && left.object.property?.name === 'exports' && property) exports.push(property);
    }
    if (node.type === 'ImportExpression') imports.push({ kind: 'dynamic-import', specifier: value(node.source), line });
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const kind = callee?.type === 'Import' ? 'dynamic-import'
        : callee?.type === 'Identifier' && callee.name === 'require' ? 'require' : null;
      if (kind) imports.push({ kind, specifier: value(node.arguments[0]), line });
      if (callee?.name === 'eval' || callee?.name === 'Function') imports.push({ kind: 'dynamic-evaluation', specifier: null, line });
    }
    if (node.type === 'NewExpression' && node.callee?.name === 'Function') imports.push({ kind: 'dynamic-evaluation', specifier: null, line });
  });
  return { file, imports, exports: [...new Set(exports)].sort(), identifiers: [...identifiers].sort(),
    unresolvedDynamic: imports.filter(item => item.specifier === null) };
}

export function normalizeKnip(report) {
  if (!report || !Array.isArray(report.issues) || (report.files !== undefined && !Array.isArray(report.files))) throw new Error('Unsupported Knip JSON shape; inspect tool output instead of treating it as clean.');
  const findings = (report.files || []).map(file => `knip:files:${typeof file === 'string' ? file : file.file}`);
  for (const issue of report.issues) {
    for (const [kind, values] of Object.entries(issue)) {
      if (kind === 'file' || !Array.isArray(values)) continue;
      for (const item of values) {
        const symbol = typeof item === 'string' ? item : item.name || item.symbol || item.specifier;
        if (symbol) findings.push(kind === 'files' ? `knip:files:${issue.file}` : `knip:${kind}:${issue.file}:${symbol}`);
      }
    }
  }
  return [...new Set(findings)].sort();
}

export function newFindings(before, after) {
  const known = new Set(before);
  return [...new Set(after)].filter(item => !known.has(item)).sort();
}

export function policyViolations(root, config, inventory) {
  const policy = config.policy;
  if (!['observe', 'enforce'].includes(policy.mode)) throw new Error('policy.mode must be observe or enforce');
  const prohibitions = ['forbiddenModules', 'forbiddenSymbols', 'forbiddenPaths', 'forbiddenText'];
  for (const key of [...prohibitions, 'allowedReferencePaths']) if (!Array.isArray(policy[key])) throw new Error(`policy.${key} must be an array`);
  if (policy.mode === 'enforce' && (!policy.removedFeature || !prohibitions.some(key => policy[key].length))) {
    throw new Error('An enforced removal needs a named feature and at least one prohibition; an empty policy is not a removal guard.');
  }
  const violations = [];
  const exempt = file => policy.allowedReferencePaths.some(path => file === path || file.startsWith(`${path}/`));
  for (const module of inventory) {
    if (exempt(module.file)) continue;
    for (const imp of module.imports) {
      if (imp.specifier && policy.forbiddenModules.some(name => imp.specifier === name || imp.specifier.startsWith(`${name}/`))) violations.push(`${module.file}:${imp.line}: forbidden import ${imp.specifier}`);
    }
    for (const name of policy.forbiddenSymbols) if (module.identifiers.includes(name)) violations.push(`${module.file}: forbidden symbol ${name}`);
  }
  for (const file of scopedFiles(root, config)) {
    if (exempt(file)) continue;
    for (const rule of policy.forbiddenText) {
      if (typeof rule.text !== 'string' || !Array.isArray(rule.paths)) throw new Error('forbiddenText requires {text, paths[]}');
      if (rule.paths.some(path => file === path || file.startsWith(`${path}/`)) && readFileSync(inside(root, file), 'utf8').includes(rule.text)) violations.push(`${file}: forbidden configuration reference ${rule.text}`);
    }
    if (file.endsWith('package.json')) {
      const pkg = JSON.parse(readFileSync(inside(root, file), 'utf8'));
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg[key] || {})) if (policy.forbiddenModules.includes(name)) violations.push(`${file}: forbidden dependency ${name}`);
      }
    }
  }
  for (const path of policy.forbiddenPaths) if (existsSync(inside(root, path)) && !exempt(path)) violations.push(`forbidden path remains: ${path}`);
  for (const file of config.entryPoints || []) if (!existsSync(inside(root, file))) violations.push(`required entry point removed: ${file}`);
  for (const [file, names] of Object.entries(config.publicExports || {})) {
    const exports = inventory.find(module => module.file === file)?.exports || [];
    for (const name of names) if (!exports.includes(name)) violations.push(`public export removed: ${file}:${name}`);
  }
  return [...new Set(violations)].sort();
}

function configFor(root, configPath) {
  const config = JSON.parse(readFileSync(inside(root, configPath), 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.sourceRoots) || !Array.isArray(config.configurationFiles)) throw new Error('Unsupported or incomplete surgical-refactor configuration');
  if (!Array.isArray(config.checks) || !config.checks.some(check => check.required !== false)) throw new Error('At least one required native/test check is necessary; an empty verification is not success.');
  if (!config.baseline.startsWith('.surgical-refactor/') || !config.baseline.endsWith('.json')) throw new Error('Store baseline JSON inside .surgical-refactor/, never over a source or package manifest.');
  for (const check of config.checks) if (!/^[a-z][a-z0-9-]*$/i.test(check.name)) throw new Error('Check names must be simple identifiers, not paths.');
  for (const path of [...config.sourceRoots, ...config.configurationFiles, config.baseline, config.contracts]) inside(root, path);
  return config;
}

function inventoryFor(root, config, target) {
  const files = scopedFiles(root, config);
  const modules = files.filter(file => codeExtension.test(file)).map(file => astInventory(readFileSync(inside(root, file), 'utf8'), file));
  const manifest = existsSync(join(root, 'package.json')) ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : {};
  const packages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const frameworks = packages.filter(name => ['react', 'next', 'vue', 'nuxt', 'express', 'fastify', '@nestjs/core', 'svelte', 'angular'].includes(name));
  return { languages: [...new Set(files.map(file => file.split('.').at(-1)))], entryPoints: config.entryPoints,
    stack: { runtime: 'Node.js', moduleFormat: manifest.type || 'inferred', frameworks,
      packageScripts: Object.keys(manifest.scripts || {}), buildScript: !!manifest.scripts?.build },
    modules, unresolvedDynamic: modules.flatMap(m => m.unresolvedDynamic.map(item => ({ file: m.file, ...item }))),
    targetReferences: target ? files.flatMap(file => readFileSync(inside(root, file), 'utf8').split('\n')
      .flatMap((line, index) => line.toLowerCase().includes(target.toLowerCase()) ? [{ file, line: index + 1 }] : [])) : [],
    target: target || null, limitation: 'Static reachability is evidence, not proof of exclusive ownership. Review dynamic imports, shell launchers, config registries and external consumers.' };
}

function localBin(name) {
  const path = join(tooling, 'node_modules', '.bin', name);
  if (!existsSync(path)) throw new Error(`Missing local ${name}. Run npm run refactor:setup; no implicit downloads during analysis.`);
  return path;
}

function analyze(root, config, output, target) {
  const inventory = inventoryFor(root, config, target);
  if (inventory.modules.length === 0) throw new Error('No JS/TS modules in analysis scope. Discover the language and configure native tooling; zero scanned files is not success.');
  writeJson(join(output, 'inventory.json'), inventory);
  const cfg = name => join(skillRoot, 'config', name);
  const semgrepLocal = join(tooling, '.venv', 'bin/semgrep');
  const commands = [
    ['knip', [localBin('knip'), '--config', cfg('knip.json'), '--reporter', 'json', '--no-progress']],
    ['graph', [localBin('depcruise'), '--config', cfg('dependency-cruiser.cjs'), '--output-type', 'json', ...config.sourceRoots]],
    ['ast-grep', [localBin('ast-grep'), 'scan', '--config', cfg('sgconfig.yml'), '--json', ...config.sourceRoots]],
    ['semgrep', [existsSync(semgrepLocal) ? semgrepLocal : 'semgrep', 'scan', '--config', cfg('semgrep.yml'), '--metrics', 'off', '--disable-version-check', '--json', '--error', ...config.sourceRoots]],
  ];
  const reports = {}, runs = [], failures = [];
  for (const [name, command] of commands) {
    const result = run(command, { root, output, name });
    runs.push({ name, command, exitCode: result.exitCode, durationMs: result.durationMs, error: result.error });
    try { reports[name] = parseJsonRun(result); }
    catch (error) { failures.push(error.message); }
  }
  const findings = [];
  if (reports.knip) findings.push(...normalizeKnip(reports.knip));
  if (reports.graph) {
    for (const item of reports.graph.summary?.violations || []) findings.push(`graph:${item.rule?.name}:${item.from}:${item.to}`);
    const graph = reports.graph.modules || [];
    const edges = graph.flatMap(module => module.dependencies.filter(dep => dep.resolved && !dep.coreModule)
      .map(dep => [module.source, dep.resolved]));
    const labels = new Map([...new Set(edges.flat())].map((path, index) => [path, `n${index}`]));
    const escape = text => text.replaceAll('"', '&quot;').replaceAll('\n', ' ');
    writeFileSync(join(output, 'graph.mmd'), ['flowchart LR', ...[...labels].map(([path, id]) => `  ${id}["${escape(path)}"]`), ...edges.map(([a,b]) => `  ${labels.get(a)} --> ${labels.get(b)}`)].join('\n') + '\n');
  }
  if (reports['ast-grep']) for (const issue of reports['ast-grep']) findings.push(`ast:${issue.ruleId}:${issue.file}`);
  if (reports.semgrep) {
    for (const issue of reports.semgrep.results || []) findings.push(`semgrep:${issue.check_id}:${issue.path}`);
    for (const error of reports.semgrep.errors || []) failures.push(`Semgrep parsing/scanning error: ${error.type || error.message}`);
    if (!reports.semgrep.paths?.scanned?.length) failures.push('Semgrep scanned no files; review scope/ignore settings.');
  }
  const result = { inventory, findings: [...new Set(findings)].sort(), runs, failures };
  writeJson(join(output, 'analysis.json'), result);
  return result;
}

function checks(root, config, output) {
  return config.checks.map(check => {
    const result = run(check.command, { root, output, name: check.name, timeout: check.timeoutMs || 120000 });
    return { name: check.name, required: check.required !== false, exitCode: result.exitCode,
      durationMs: result.durationMs, error: result.error, command: check.command };
  });
}

function fingerprints(root, config) {
  return Object.fromEntries(scopedFiles(root, config).map(file => [file, createHash('sha256').update(readFileSync(inside(root, file))).digest('hex')]));
}

function compare(root, config, current) {
  if (!existsSync(inside(root, config.baseline))) throw new Error('No reviewed baseline. Run baseline on a work branch before verification.');
  const baseline = JSON.parse(readFileSync(inside(root, config.baseline), 'utf8'));
  const additions = newFindings(baseline.findings, current.findings);
  const violations = policyViolations(root, config, current.inventory.modules);
  return { policyMode: config.policy.mode, removedFeature: config.policy.removedFeature,
    newFindings: additions, forbiddenReferences: violations, preexistingFindings: current.findings.filter(f => baseline.findings.includes(f)),
    passed: additions.length === 0 && violations.length === 0 && current.failures.length === 0,
    limitation: config.policy.mode === 'observe' ? 'No feature has been removed; forbidden-feature guard is not armed.' : null };
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const option = key => { const index = argv.indexOf(key); return index >= 0 ? argv[index + 1] : undefined; };
  const root = resolve(option('--root') || process.cwd());
  const config = configFor(root, option('--config') || '.surgical-refactor/config.json');
  const output = inside(join(root, '.surgical-refactor/artifacts'), option('--run') || command || 'unknown');
  mkdirSync(output, { recursive: true });
  if (command === 'report') {
    const baseline = JSON.parse(readFileSync(inside(root, config.baseline), 'utf8'));
    const verificationPath = inside(root, '.surgical-refactor/artifacts/verify/verification.json');
    const verification = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, 'utf8')) : null;
    const now = fingerprints(root, config);
    const fresh = verification && JSON.stringify(verification.sourceHashes) === JSON.stringify(now);
    const removed = Object.keys(baseline.sourceHashes).filter(file => !(file in now));
    const changed = Object.keys(now).filter(file => baseline.sourceHashes[file] !== now[file]);
    const mutationFile = inside(root, '.surgical-refactor/artifacts/mutation/mutation.json');
    let mutation = 'Not executed';
    if (existsSync(mutationFile)) {
      const report = JSON.parse(readFileSync(mutationFile, 'utf8'));
      const mutants = Object.values(report.files || {}).flatMap(file => file.mutants || []);
      const counts = Object.fromEntries([...new Set(mutants.map(item => item.status))].map(status => [status, mutants.filter(item => item.status === status).length]));
      mutation = JSON.stringify(counts);
    }
    const document = [
      '# Surgical refactor evidence', '', `Policy: ${config.policy.mode}; feature: ${config.policy.removedFeature || 'none removed'}.`,
      '', '## Removed scoped files', ...(removed.length ? removed.map(f => `- ${f}`) : ['None.']),
      '', '## Added/changed scoped files since baseline', ...(changed.length ? changed.map(f => `- ${f}`) : ['None.']),
      '', '## Before checks', ...baseline.checks.map(c => `- ${c.name}: exit ${c.exitCode}`),
      '', '## After checks', ...(verification?.checks?.map(c => `- ${c.name}: exit ${c.exitCode}`) || ['Not executed.']),
      '', '## Mutation statuses', mutation,
      '', '## Graph, contracts and limitations', `Contracts: ${config.contracts}.`,
      'Dependency graph: ../verify/graph.mmd and ../verify/graph.stdout.log. AST inventory: ../verify/inventory.json.',
      verification ? `Verification passed: ${fresh && verification.passed}. Evidence fresh: ${!!fresh}. New findings: ${verification.newFindings.length}.` : 'No verification evidence.',
      'Mutation coverage is restricted to the configured range; native shell branches and unresolved computed imports require manual review.',
      'Static reachability and passing syntax checks do not establish semantic equivalence. Review configuration registrations and external contracts.', '',
    ].join('\n');
    writeFileSync(join(output, 'REPORT.md'), document);
    console.log(relative(root, join(output, 'REPORT.md')));
    return 0;
  }
  if (command === 'inventory') {
    const result = inventoryFor(root, config, option('--target'));
    writeJson(join(output, 'inventory.json'), result);
    console.log(JSON.stringify({ files: result.modules.length, languages: result.languages, stack: result.stack,
      unresolvedDynamic: result.unresolvedDynamic, targetReferences: result.targetReferences, report: relative(root, output) }, null, 2));
    return 0;
  }
  if (command === 'mutation') {
    const result = run([localBin('stryker'), 'run', join(skillRoot, 'config/stryker.config.mjs')], { root, output, name: 'stryker', timeout: 600000 });
    console.log(result.stdout.slice(-5000));
    if (result.exitCode !== 0 || result.error) console.error(result.stderr.slice(-3000));
    return result.exitCode === 0 && !result.error ? 0 : 1;
  }
  if (!['baseline', 'analyze', 'guard', 'verify'].includes(command)) throw new Error('Use inventory | baseline | analyze | guard | verify | mutation | report, with optional --root, --config, --target, --run.');
  if (command === 'baseline') {
    const branch = option('--branch');
    if (branch) {
      const result = run(['git', 'switch', '-c', branch], { root });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    }
    const currentBranch = run(['git', 'branch', '--show-current'], { root }).stdout.trim();
    if (!currentBranch || ['main', 'master'].includes(currentBranch)) throw new Error('Baseline requires a work branch. Use --branch refactor/<task>; never reset or stash user changes.');
    if (existsSync(inside(root, config.baseline)) && !argv.includes('--accept-baseline')) throw new Error('Baseline already exists. Inspect differences before explicitly using --accept-baseline. CI must never accept a new baseline.');
    const currentChecks = checks(root, config, output);
    const current = analyze(root, config, output, option('--target'));
    const baseline = { version: 1, branch: currentBranch, head: run(['git', 'rev-parse', 'HEAD'], { root }).stdout.trim(),
      capturedAt: new Date().toISOString(), findings: current.findings, checks: currentChecks,
      sourceHashes: fingerprints(root, config), publicExports: Object.fromEntries(current.inventory.modules.map(m => [m.file, m.exports])), contracts: config.contracts, failures: current.failures };
    writeJson(inside(root, config.baseline), baseline);
    console.log(JSON.stringify({ baseline: config.baseline, preexistingFailures: currentChecks.filter(c => c.exitCode !== 0), toolFailures: current.failures, findings: current.findings }, null, 2));
    return current.failures.length || currentChecks.some(c => c.required && c.exitCode !== 0) ? 1 : 0;
  }
  const current = analyze(root, config, output, option('--target'));
  if (command === 'analyze') {
    console.log(JSON.stringify({ findings: current.findings, failures: current.failures, report: relative(root, output) }, null, 2));
    return current.failures.length ? 1 : 0;
  }
  const result = compare(root, config, current);
  const currentChecks = command === 'verify' ? checks(root, config, output) : [];
  const failedChecks = currentChecks.filter(c => c.required && (c.exitCode !== 0 || c.error));
  const summary = { ...result, checks: currentChecks, toolFailures: current.failures,
    sourceHashes: fingerprints(root, config), capturedAt: new Date().toISOString(),
    passed: result.passed && failedChecks.length === 0, report: relative(root, output) };
  writeJson(join(output, 'verification.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
  return summary.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(redact(error.stack)); process.exitCode = 1; });
}
