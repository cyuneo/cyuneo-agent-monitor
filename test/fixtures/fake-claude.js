#!/usr/bin/env node
'use strict';
// 假的 Claude Code 命令行，只给 test/compact.test.js 用（绝不调用真实的 claude，也不碰 ~/.claude）。
// 模拟：claude -p --resume <id> --model <model> --output-format json "<prompt>"
// - 往合成的会话记录里追加一条 system/compact_boundary，并在 stdout 打印结果 JSON；
// - 行为由环境变量控制：
//   FAKE_CLAUDE_PROJECTS  在这个目录（及其下一层）里找 <id>.jsonl；必须设（或设 FAKE_CLAUDE_TRANSCRIPT）
//   FAKE_CLAUDE_TRANSCRIPT 直接指定记录文件
//   FAKE_CLAUDE_LOG       把收到的参数、cwd、stdin 类型写成 JSON
//   FAKE_CLAUDE_PIDFILE   启动后写入自己的 pid
//   FAKE_CLAUDE_MODE      ok（默认）| error（stderr 8 行、退出码 1）| isError（结果 JSON 带 is_error）
//                         | hang（一直等，直到被结束；最多 FAKE_CLAUDE_HANG_MAX_MS，默认 60 秒）
//                         | noBoundary（成功但不写 compact_boundary）
//   FAKE_CLAUDE_COST      total_cost_usd（默认 0.0123）
//   FAKE_CLAUDE_POST      压缩后的 token 数（默认 preTokens 的 3%）

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
      } catch { /* 忽略 */ }
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

// 参数形状必须和扩展约定的一致
const ok = argv.length === 8 && argv[0] === '-p' && argv[1] === '--resume' && argv[3] === '--model'
  && argv[5] === '--output-format' && argv[6] === 'json' && /^\/compact\b/.test(argv[7]);
if (!ok) {
  process.stderr.write('fake-claude: unexpected arguments\n');
  process.exit(2);
}
const sessionId = argv[2];
const model = argv[4];

if (mode === 'hang') {
  // 一直等到被结束；万一测试进程先没了，最多等 60 秒自己退出，不留孤儿进程
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

// preTokens：记录里最后一条 assistant 的输入侧 token
let pre = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.includes('"assistant"')) continue;
  try {
    const e = JSON.parse(line);
    const u = e && e.message && e.message.usage;
    if (e.type === 'assistant' && u) pre = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  } catch { /* 忽略 */ }
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
