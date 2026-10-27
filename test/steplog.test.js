'use strict';
// Unit tests for lib/core/steplog.js (the call log behind a step block). Run with plain Node: node test/steplog.test.js
// All data is synthetic. Temp files go under AGENT_MONITOR_TEST_TMP (or the system temp dir if unset) and are deleted afterwards.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readStep } = require('../lib/core/steplog');

const TMP_ROOT = process.env.AGENT_MONITOR_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_ROOT, 'am-steplog-'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const write = (name, lines) => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, lines.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');
  return f;
};

const claudeUse = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const claudeResult = (id, content, isError) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

test('Claude Code: a shell command shows as the command, other input as JSON; the result text and its error flag', async () => {
  const f = write('claude.jsonl', [
    { type: 'user', message: { role: 'user', content: 'Run the tests' } },
    claudeUse('toolu_1', 'Bash', { command: 'npm test', description: 'Run tests' }),
    claudeUse('toolu_10', 'Read', { file_path: '/work/a.js' }),
    claudeResult('toolu_10', [{ type: 'text', text: 'const a = 1;' }]),
    claudeResult('toolu_1', 'Exit code 1\nfailing: 2', true),
  ]);
  const a = await readStep(f, 'toolu_1');
  assert.deepStrictEqual(a, { found: true, tool: 'Bash', input: 'npm test', inputTruncated: false, output: 'Exit code 1\nfailing: 2', outputTruncated: false, isError: true });
  const b = await readStep(f, 'toolu_10');
  assert.strictEqual(b.input, JSON.stringify({ file_path: '/work/a.js' }, null, 2));
  assert.strictEqual(b.output, 'const a = 1;');
  assert.strictEqual(b.isError, false);
});

test('a call still running has its input and no output; an unknown id finds nothing; long text is cut', async () => {
  const f = write('running.jsonl', [claudeUse('toolu_2', 'Grep', { pattern: 'x'.repeat(50) })]);
  const a = await readStep(f, 'toolu_2', { maxChars: 20 });
  assert.strictEqual(a.found, true);
  assert.strictEqual(a.input.length, 20);
  assert.strictEqual(a.inputTruncated, true);
  assert.strictEqual(a.output, null);
  assert.deepStrictEqual(await readStep(f, 'toolu_9'), { found: false, tool: null, input: null, inputTruncated: false, output: null, outputTruncated: false, isError: false });
  assert.strictEqual((await readStep(f, '')).found, false);
});

test('Codex: function_call arguments (a command array joined) and function_call_output', async () => {
  const f = write('codex.jsonl', [
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call_7', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'], workdir: '/w' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_7', output: JSON.stringify({ output: 'total 0' }) } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_8', input: '*** Begin Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_8', output: { output: 'Success' } } },
  ]);
  const a = await readStep(f, 'call_7');
  assert.strictEqual(a.tool, 'shell');
  assert.strictEqual(a.input, 'bash -lc ls -la');
  assert.strictEqual(a.output, 'total 0', 'the JSON wrapper Codex writes is taken off');
  const b = await readStep(f, 'call_8');
  assert.deepStrictEqual([b.tool, b.input, b.output], ['apply_patch', '*** Begin Patch', 'Success']);
});

test('lines across 1MB read chunks, broken lines, and a last line without a newline', async () => {
  const big = 'y'.repeat((1 << 20) + 100);
  const f = path.join(TMP, 'chunks.jsonl');
  fs.writeFileSync(f, [
    '{broken',
    JSON.stringify(claudeUse('toolu_3', 'Write', { file_path: '/w/b.txt', content: big })),
    JSON.stringify(claudeResult('toolu_3', 'written')),
  ].join('\n'));
  const a = await readStep(f, 'toolu_3');
  assert.strictEqual(a.inputTruncated, true);
  assert.ok(a.input.startsWith('{\n  "file_path": "/w/b.txt"'));
  assert.strictEqual(a.output, 'written');
});

(async () => {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`  ok    ${name}`);
      } catch (err) {
        failed++;
        console.log(`  FAIL  ${name}\n        ${String((err && err.stack) || err).split('\n').slice(0, 4).join('\n        ')}`);
      }
    }
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
