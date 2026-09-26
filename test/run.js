#!/usr/bin/env node
'use strict';
// Cross-platform test runner (replaces the POSIX-only shell loop in package.json).
// Runs every test/*.test.js in sorted order, one at a time, each in its own Node process
// with AGENT_MONITOR_SKIP_REAL=1. Stops at the first failing file and exits with its code.
// On GitHub Actions it runs every file instead, and reports each failing test as an error
// annotation, so one run shows all failures on the run page without opening the log.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = __dirname;
const root = path.dirname(testDir);
const ci = process.env.GITHUB_ACTIONS === 'true';

const files = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error('no test files found in test/');
  process.exit(1);
}

// Workflow-command escaping: data escapes %, CR and LF; properties also escape : and ,.
function escData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escProp(s) {
  return escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

// One annotation per "  FAIL  <name>" line, with the indented lines under it as the message.
// A file that failed without such a line (a crash before any test ran) gets its output's tail.
function annotate(name, output) {
  const lines = output.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*FAIL\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && /^( {8}| {4,}at )/.test(lines[j]); j++) body.push(lines[j].trim());
    found.push({ title: `test/${name}: ${m[1]}`, body: body.join('\n').trim() || m[1] });
  }
  if (found.length === 0) found.push({ title: `test/${name}`, body: lines.slice(-30).join('\n') });
  for (const f of found.slice(0, 10)) {
    console.log(`::error title=${escProp(f.title.slice(0, 200))}::${escData(f.body)}`);
  }
}

const env = { ...process.env, AGENT_MONITOR_SKIP_REAL: '1' };
const started = Date.now();
let passed = 0;
const failed = [];

for (const name of files) {
  // Print a forward-slash path on every platform so the output is stable.
  console.log(`== test/${name}`);
  const result = spawnSync(process.execPath, [path.join(testDir, name)], {
    cwd: root,
    env,
    stdio: ci ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (ci) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  let code = result.status;
  if (result.error) {
    console.error(`failed to start test/${name}: ${result.error.message}`);
    code = 1;
  } else if (code === null) {
    // Killed by a signal: there is no exit code, so report the signal and fail with 1.
    console.error(`test/${name} was terminated by signal ${result.signal}`);
    code = 1;
  }

  if (code !== 0) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!ci) {
      console.log(`FAIL test/${name} (exit ${code}); ${passed}/${files.length} files passed before it, ${secs}s`);
      process.exit(code);
    }
    console.log(`FAIL test/${name} (exit ${code})`);
    annotate(name, `${result.stdout || ''}\n${result.stderr || ''}`.trim());
    failed.push({ name, code });
    continue;
  }
  passed += 1;
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
  console.log(`FAIL ${failed.map((f) => `test/${f.name}`).join(', ')}; ${passed}/${files.length} files passed, ${secs}s`);
  process.exit(failed[0].code);
}
console.log(`all ${passed} test files passed in ${secs}s`);
