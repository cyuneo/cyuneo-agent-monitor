#!/usr/bin/env node
'use strict';
// Cross-platform test runner (replaces the POSIX-only shell loop in package.json).
// Runs every test/*.test.js in sorted order, one at a time, each in its own Node process
// with AGENT_MONITOR_SKIP_REAL=1. Stops at the first failing file and exits with its code.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = __dirname;
const root = path.dirname(testDir);

const files = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error('no test files found in test/');
  process.exit(1);
}

const env = { ...process.env, AGENT_MONITOR_SKIP_REAL: '1' };
const started = Date.now();
let passed = 0;

for (const name of files) {
  // Print a forward-slash path on every platform so the output is stable.
  console.log(`== test/${name}`);
  const result = spawnSync(process.execPath, [path.join(testDir, name)], {
    cwd: root,
    env,
    stdio: 'inherit',
  });

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
    console.log(`FAIL test/${name} (exit ${code}); ${passed}/${files.length} files passed before it, ${secs}s`);
    process.exit(code);
  }
  passed += 1;
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`all ${passed} test files passed in ${secs}s`);
