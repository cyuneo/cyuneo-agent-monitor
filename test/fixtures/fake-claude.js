#!/usr/bin/env node
'use strict';
// Fake Claude Code CLI, used only by test/compact.test.js (never calls the real claude and never touches ~/.claude).
// Simulates: claude -p --resume <id> --model <model> --output-format json "<prompt>"
// - appends a system/compact_boundary entry to the synthetic transcript and prints a result JSON to stdout;
// - behavior is controlled by environment variables:
//   FAKE_CLAUDE_PROJECTS  look for <id>.jsonl in this directory (and one level below); required (unless FAKE_CLAUDE_TRANSCRIPT is set)
//   FAKE_CLAUDE_TRANSCRIPT path of the transcript file to use directly
//   FAKE_CLAUDE_LOG       write the received arguments, cwd and stdin kind here as JSON
//   FAKE_CLAUDE_PIDFILE   write own pid here after startup
//   FAKE_CLAUDE_MODE      ok (default) | error (8 lines on stderr, exit code 1) | isError (result JSON has is_error)
//                         | hang (wait until killed; at most FAKE_CLAUDE_HANG_MAX_MS, default 60 s)
//                         | noBoundary (succeed but do not write compact_boundary)
//   FAKE_CLAUDE_COST      total_cost_usd (default 0.0123)
//   FAKE_CLAUDE_POST      token count after compaction (default 3% of preTokens)

const fs = require('fs');
const path = require('path');

const env = process.env;
const argv = process.argv.slice(2);
const mode = env.FAKE_CLAUDE_MODE || 'ok';

function stdinKind() {
  try {
    const st = fs.fstatSync(0);
    if (st.isFIFO()) return 'pipe';
    if (st.isCharacterDevice()) {
      try {
        const dn = fs.statSync(process.platform === 'win32' ? 'NUL' : '/dev/null');
        if (dn.rdev === st.rdev) return 'devnull';
      } catch { /* ignore */ }
      return 'tty';
    }
    return 'other';
  } catch {
    return 'closed';
  }
}

if (env.FAKE_CLAUDE_PIDFILE) fs.writeFileSync(env.FAKE_CLAUDE_PIDFILE, String(process.pid));
if (env.FAKE_CLAUDE_LOG) {
  fs.writeFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, cwd: process.cwd(), stdin: stdinKind(), pid: process.pid }));
}

// Argument shape must match what the extension sends
const ok = argv.length === 8 && argv[0] === '-p' && argv[1] === '--resume' && argv[3] === '--model'
  && argv[5] === '--output-format' && argv[6] === 'json' && /^\/compact\b/.test(argv[7]);
if (!ok) {
  process.stderr.write('fake-claude: unexpected arguments\n');
  process.exit(2);
}
const sessionId = argv[2];
const model = argv[4];

if (mode === 'hang') {
  // Wait until killed; if the test process dies first, exit on our own after at most 60 s so no orphan is left behind
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(3), Number(env.FAKE_CLAUDE_HANG_MAX_MS) || 60000);
  return;
}
if (mode === 'error') {
  for (let i = 1; i <= 8; i++) process.stderr.write(`fake error line ${i}\n`);
  process.exit(1);
}
if (mode === 'isError') {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long', session_id: sessionId, total_cost_usd: 0 }) + '\n');
  process.exit(1);
}

function findTranscript() {
  if (env.FAKE_CLAUDE_TRANSCRIPT) return env.FAKE_CLAUDE_TRANSCRIPT;
  const root = env.FAKE_CLAUDE_PROJECTS;
  if (!root) return null;
  const name = sessionId + '.jsonl';
  if (fs.existsSync(path.join(root, name))) return path.join(root, name);
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const file = findTranscript();
if (!file) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}

// preTokens: input-side tokens of the last assistant entry in the transcript
let pre = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.includes('"assistant"')) continue;
  try {
    const e = JSON.parse(line);
    const u = e && e.message && e.message.usage;
    if (e.type === 'assistant' && u) pre = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  } catch { /* ignore */ }
}
const post = env.FAKE_CLAUDE_POST ? Number(env.FAKE_CLAUDE_POST) : Math.round(pre * 0.03);
const ts = new Date().toISOString();
if (mode !== 'noBoundary') {
  const rows = [
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, level: 'info', timestamp: ts, sessionId, cwd: process.cwd(), version: '9.9.9-fake', entrypoint: 'sdk-cli', compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: post, durationMs: 1234 } },
    { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: ts, sessionId, message: { role: 'user', content: 'Synthetic summary.' } },
  ];
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const cost = env.FAKE_CLAUDE_COST ? Number(env.FAKE_CLAUDE_COST) : 0.0123;
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1200, num_turns: 1,
  result: '', session_id: sessionId, total_cost_usd: cost,
  usage: { input_tokens: 10, cache_creation_input_tokens: pre, cache_read_input_tokens: 0, output_tokens: 1900 },
  modelUsage: { [model]: { inputTokens: 10, outputTokens: 1900, cacheReadInputTokens: 0, cacheCreationInputTokens: pre, costUSD: cost } },
}) + '\n');
