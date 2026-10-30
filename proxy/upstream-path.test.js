import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamPath } from './model-proxy.js';

test('upstream path contract covers root, trailing slash, overlap and query flags', () => {
  const cases = [
    ['https://api.deepseek.com/anthropic', '/v1/messages', '/anthropic/v1/messages'],
    ['https://api.deepseek.com/anthropic/', '/v1/messages?beta=true', '/anthropic/v1/messages?beta=true'],
    ['https://api.deepseek.com/', '/v1/messages', '/v1/messages'],
    ['https://api.deepseek.com/anthropic/v1', '/v1/messages', '/anthropic/v1/messages'],
    ['https://api.deepseek.com/anthropic/v1/', '/v1/messages?beta=true&x=1', '/anthropic/v1/messages?beta=true&x=1'],
    ['https://api.deepseek.com/v1/messages', '/v1/messages', '/v1/messages'],
    ['https://api.deepseek.com/anthropic', '/v1/messages?', '/anthropic/v1/messages?'],
    ['https://api.deepseek.com', '/v1/messages?a=1?b=2', '/v1/messages?a=1?b=2'],
  ];
  for (const [target, input, expected] of cases) assert.equal(buildUpstreamPath(new URL(target), input), expected, `${target} + ${input}`);
});
