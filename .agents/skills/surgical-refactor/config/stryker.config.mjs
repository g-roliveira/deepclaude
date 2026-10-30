import { readFileSync } from 'node:fs';
const file = 'proxy/model-proxy.js';
const lines = readFileSync(file, 'utf8').split('\n');
const first = lines.findIndex(line => line.startsWith('export function buildUpstreamPath('));
const next = lines.findIndex((line, index) => index > first && line.startsWith('export function startModelProxy('));
if (first < 0 || next < 0) throw new Error('Mutation target moved; review the selected function before running.');
const modeFirst = lines.findIndex(line => line.includes("defaultMode = defaultMode === 'ds'"));
const modeEnd = lines.findIndex((line, index) => index > modeFirst && line.includes('const initialTarget ='));
const registry = lines.findIndex(line => line.includes("if (name !== 'deepseek') throw"));
const keyFirst = lines.findIndex(line => line.includes("if (initialName === 'deepseek' &&"));
if ([modeFirst, modeEnd, registry, keyFirst].some(index => index < 0)) throw new Error('Provider mutation guards moved; review their ranges.');
export default {
  mutate: [
    `${file}:${first + 1}:0-${next}:0`,
    `${file}:${modeFirst + 1}:0-${modeEnd}:0`,
    `${file}:${registry + 1}:0-${registry + 2}:0`,
    `${file}:${keyFirst + 1}:0-${keyFirst + 4}:0`,
  ],
  testRunner: 'command',
  commandRunner: { command: 'node --test proxy/upstream-path.test.js proxy/provider-contract.test.js' },
  coverageAnalysis: 'off',
  concurrency: 1,
  timeoutMS: 10000,
  timeoutFactor: 2,
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '.surgical-refactor/artifacts/mutation/mutation.json' },
  tempDirName: '.surgical-refactor/artifacts/stryker-sandbox',
  ignorePatterns: ['.agents/skills/surgical-refactor/tooling/**', '.surgical-refactor/artifacts/**', '.deepclaude/**', '.claude/**', 'screenshots/**', '*.png'],
  thresholds: { high: 90, low: 70, break: 90 },
};
