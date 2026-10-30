import { readFileSync } from 'node:fs';
const file = 'proxy/model-proxy.js';
const lines = readFileSync(file, 'utf8').split('\n');
const first = lines.findIndex(line => line.startsWith('export function buildUpstreamPath('));
const next = lines.findIndex((line, index) => index > first && line.startsWith('export function startModelProxy('));
if (first < 0 || next < 0) throw new Error('Mutation target moved; review the selected function before running.');
export default {
  mutate: [`${file}:${first + 1}:0-${next}:0`],
  testRunner: 'command',
  commandRunner: { command: 'node --test proxy/upstream-path.test.js' },
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
