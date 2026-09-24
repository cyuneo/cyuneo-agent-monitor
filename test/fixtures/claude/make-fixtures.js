'use strict';
// 生成合成的 Claude Code 记录样例（全部虚构，不含任何真实对话）。
// 用法：node test/fixtures/claude/make-fixtures.js  → 覆盖写 test/fixtures/claude/projects/**
// 结构照 Claude Code 2.1.2xx 的本机记录格式（只取键名与取值形状）。
// 测试会把 projects/ 复制到临时目录，再按每个文件最后一行的时间改 mtime。

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'projects');
const CWD = '/tmp/am-fixture';
const PROJ = CWD.replace(/[^a-zA-Z0-9]/g, '-');
const DAY = '2026-09-20';

// 时间：分:秒（UTC 10 点起）
const T = (mm, ss = 0) => `${DAY}T10:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;

const SID = {
  A: 'aaaaaaaa-0000-4000-8000-000000000001', // 主会话完成 + 子智能体 + 工作流（有一个智能体挂着 Read）
  B: 'bbbbbbbb-0000-4000-8000-000000000002', // 撞额度 429（quotaLimits）
  C: 'cccccccc-0000-4000-8000-000000000003', // 用户打断（前台子智能体随之停下）
  D: 'dddddddd-0000-4000-8000-000000000004', // /compact 之后
  E: 'eeeeeeee-0000-4000-8000-000000000005', // 正在重试
  F: 'ffffffff-0000-4000-8000-000000000006', // 529 过载
  G: '99999999-0000-4000-8000-000000000007', // AskUserQuestion 等回答
  H: '88888888-0000-4000-8000-000000000008', // 在线会话（登记表），挂着 Edit
  I: '77777777-0000-4000-8000-000000000009', // 老版本、挂着 Read（没有登记表信号 → 推测）
  J: '66666666-0000-4000-8000-00000000000a', // 撞额度文字版（无 quotaLimits）+ synthetic “No response requested.”
};

let uuidN = 0;
function base(sid, type, ts, extra = {}) {
  uuidN++;
  return {
    parentUuid: null,
    isSidechain: false,
    type,
    uuid: `00000000-0000-4000-8000-${String(uuidN).padStart(12, '0')}`,
    timestamp: ts,
    userType: 'external',
    entrypoint: 'claude-vscode',
    cwd: CWD,
    sessionId: sid,
    version: '2.1.280',
    gitBranch: '',
    ...extra,
  };
}

function usage(o = {}) {
  const w1 = o.w1 || 0;
  const w5 = o.w5 || 0;
  return {
    input_tokens: o.input || 0,
    cache_creation_input_tokens: w1 + w5,
    cache_read_input_tokens: o.read || 0,
    output_tokens: o.out || 0,
    cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

const prompt = (sid, ts, text, extra) => base(sid, 'user', ts, { message: { role: 'user', content: text }, ...extra });
const asst = (sid, ts, id, content, stop, u, model = 'claude-opus-5-5', extra) => base(sid, 'assistant', ts, {
  message: { id, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: u },
  ...extra,
});
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (sid, ts, toolId, text, isError = false, extra = {}) => base(sid, 'user', ts, {
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text, is_error: isError }] },
  ...extra,
});
const text = (t) => ({ type: 'text', text: t });
const thinking = () => ({ type: 'thinking', thinking: 'synthetic reasoning', signature: 'sig' });

function write(rel, rows) {
  const f = path.join(OUT, PROJ, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function writeJson(rel, obj) {
  const f = path.join(OUT, PROJ, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
}

fs.rmSync(OUT, { recursive: true, force: true });

// ---------- A：主会话 + 子智能体 + 工作流 ----------
{
  const s = SID.A;
  write(`${s}.jsonl`, [
    { type: 'ai-title', sessionId: s, aiTitle: 'Synthetic session A' },
    prompt(s, T(0, 0), 'Please run the synthetic task'),
    // 同一条消息分两行写，usage 逐行更新（按 message.id 去重，取最后一次）
    asst(s, T(0, 5), 'msg_a1', [thinking()], null, usage({ input: 10, w1: 1000, out: 5 })),
    asst(s, T(0, 6), 'msg_a1', [toolUse('toolu_agent1', 'Agent', { description: 'Synthetic helper', prompt: 'help', subagent_type: 'general-purpose' })], 'tool_use', usage({ input: 10, w1: 1000, out: 50 })),
    result(s, T(2, 0), 'toolu_agent1', 'helper finished'),
    asst(s, T(2, 5), 'msg_a2', [toolUse('toolu_wf1', 'Workflow', { name: 'synth-flow', scriptPath: '/tmp/am-fixture/wf.js' })], 'tool_use', usage({ input: 5, read: 1000, out: 30 })),
    result(s, T(2, 6), 'toolu_wf1', 'Workflow launched in background: wf_abc123-def456'),
    asst(s, T(2, 10), 'msg_a3', [toolUse('toolu_edit1', 'Edit', { file_path: '/tmp/am-fixture/src/a.js', old_string: 'x', new_string: 'y' })], 'tool_use', usage({ input: 5, read: 1100, out: 20 })),
    result(s, T(2, 11), 'toolu_edit1', 'edited', false, { toolUseResult: { filePath: '/tmp/am-fixture/src/a.js', oldString: 'x', newString: 'y' } }),
    asst(s, T(2, 12), 'msg_a4', [toolUse('toolu_write1', 'Write', { file_path: '/tmp/am-fixture/src/new.js', content: '1' })], 'tool_use', usage({ input: 5, read: 1150, out: 20 })),
    result(s, T(2, 13), 'toolu_write1', 'created', false, { toolUseResult: { type: 'create', filePath: '/tmp/am-fixture/src/new.js' } }),
    asst(s, T(2, 14), 'msg_a5', [toolUse('toolu_bash1', 'Bash', { command: 'false', description: 'Run a failing command' })], 'tool_use', usage({ input: 5, read: 1200, out: 20 })),
    result(s, T(2, 20), 'toolu_bash1', 'Exit code 1\nsynthetic failure', true),
    asst(s, T(2, 30), 'msg_a6', [text('All done. Synthetic summary line.')], 'end_turn', usage({ input: 3, w1: 200, read: 1100, out: 40 })),
    { type: 'last-prompt', sessionId: s, lastPrompt: 'Please run the synthetic task' },
  ]);
  // 前台子智能体：已完成
  write(`${s}/subagents/agent-sub1.jsonl`, [
    prompt(s, T(0, 7), 'help', { isSidechain: true, agentId: 'sub1' }),
    asst(s, T(0, 10), 'msg_s1', [toolUse('toolu_s1r', 'Read', { file_path: '/tmp/am-fixture/README.md' })], 'tool_use', usage({ input: 20, w5: 500, out: 10 }), 'claude-sonnet-5', { isSidechain: true, agentId: 'sub1' }),
    result(s, T(0, 11), 'toolu_s1r', 'readme', false, { isSidechain: true, agentId: 'sub1' }),
    asst(s, T(1, 50), 'msg_s2', [text('Helper result text.')], 'end_turn', usage({ input: 5, read: 520, out: 15 }), 'claude-sonnet-5', { isSidechain: true, agentId: 'sub1' }),
  ]);
  writeJson(`${s}/subagents/agent-sub1.meta.json`, { agentType: 'general-purpose', description: 'Synthetic helper', toolUseId: 'toolu_agent1', requestShape: 'foreground' });
  // 工作流：w1 交了结果；w2 挂着 Read 没结果
  const wf = `${s}/subagents/workflows/wf_abc123-def456`;
  write(`${wf}/journal.jsonl`, [
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'w1', label: 'Phase one worker', phase: 'build' },
    { type: 'started', key: 'k2', agentId: 'w2', label: 'Phase two worker', phase: 'build' },
    { type: 'result', key: 'k1', agentId: 'w1', result: { ok: true, note: 'synthetic' } },
  ]);
  write(`${wf}/agent-w1.jsonl`, [
    prompt(s, T(2, 7), 'phase one', { isSidechain: true, agentId: 'w1' }),
    asst(s, T(3, 0), 'msg_w1a', [toolUse('toolu_w1so', 'StructuredOutput', { ok: true })], 'tool_use', usage({ input: 30, w5: 800, out: 25 }), 'claude-sonnet-5', { isSidechain: true, agentId: 'w1' }),
    result(s, T(3, 1), 'toolu_w1so', 'Structured output provided successfully', false, { isSidechain: true, agentId: 'w1' }),
  ]);
  writeJson(`${wf}/agent-w1.meta.json`, { agentType: 'workflow-agent', description: 'Phase one worker', workflowPhase: 'build' });
  write(`${wf}/agent-w2.jsonl`, [
    prompt(s, T(2, 8), 'phase two', { isSidechain: true, agentId: 'w2' }),
    asst(s, T(2, 30), 'msg_w2a', [toolUse('toolu_w2r', 'Read', { file_path: '/tmp/am-fixture/src/a.js' })], 'tool_use', usage({ input: 30, w5: 700, out: 12 }), 'claude-sonnet-5', { isSidechain: true, agentId: 'w2' }),
  ]);
  writeJson(`${wf}/agent-w2.meta.json`, { agentType: 'workflow-agent', description: 'Phase two worker', workflowPhase: 'build' });
}

// ---------- B：撞额度（2.1.270，带 quotaLimits） ----------
{
  const s = SID.B;
  const ex = { entrypoint: 'cli', version: '2.1.270' };
  write(`${s}.jsonl`, [
    { type: 'custom-title', sessionId: s, customTitle: 'Quota session B' },
    prompt(s, T(0, 0), 'Do the long synthetic job', ex),
    asst(s, T(0, 10), 'msg_b1', [toolUse('toolu_b1', 'Read', { file_path: '/tmp/am-fixture/big.txt' })], 'tool_use', usage({ input: 100, read: 50000, out: 10 }), 'claude-opus-5-5', ex),
    result(s, T(0, 12), 'toolu_b1', 'big', false, ex),
    base(s, 'assistant', T(0, 20), {
      ...ex,
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiErrorStatus: 429,
      quotaLimits: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: Date.parse('2026-09-21T17:00:00Z') / 1000, isUsingOverage: false },
      message: { id: 'msg_b_err', type: 'message', role: 'assistant', model: '<synthetic>', content: [text("You've hit your weekly limit · resets 2am (Asia/Seoul)")], stop_reason: 'stop_sequence', stop_sequence: '', usage: usage({}) },
    }),
  ]);
}

// ---------- C：用户打断，前台子智能体挂着 Read ----------
{
  const s = SID.C;
  write(`${s}.jsonl`, [
    prompt(s, T(0, 0), 'Investigate something'),
    asst(s, T(0, 5), 'msg_c1', [toolUse('toolu_agent_c', 'Agent', { description: 'Synthetic explorer', prompt: 'look' })], 'tool_use', usage({ input: 10, w1: 900, out: 20 })),
    base(s, 'user', T(1, 0), {
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_agent_c', content: 'The user doesn\'t want to proceed with this tool use.', is_error: true },
        text('[Request interrupted by user for tool use]'),
      ] },
    }),
  ]);
  write(`${s}/subagents/agent-subc.jsonl`, [
    prompt(s, T(0, 6), 'look', { isSidechain: true, agentId: 'subc' }),
    asst(s, T(0, 30), 'msg_c_s1', [toolUse('toolu_cs_r', 'Read', { file_path: '/tmp/am-fixture/x.txt' })], 'tool_use', usage({ input: 10, w5: 300, out: 8 }), 'claude-sonnet-5', { isSidechain: true, agentId: 'subc' }),
  ]);
  writeJson(`${s}/subagents/agent-subc.meta.json`, { agentType: 'Explore', description: 'Synthetic explorer', toolUseId: 'toolu_agent_c', requestShape: 'foreground' });
}

// ---------- D：手动 /compact 之后（本地命令行不改变状态） ----------
{
  const s = SID.D;
  write(`${s}.jsonl`, [
    prompt(s, T(0, 0), 'Big context work'),
    asst(s, T(0, 30), 'msg_d1', [text('Finished the big work.')], 'end_turn', usage({ input: 50, read: 150000, w1: 350, out: 100 })),
    base(s, 'system', T(1, 0), { subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, level: 'info', compactMetadata: { trigger: 'manual', preTokens: 150400, postTokens: 4000, durationMs: 9000 } }),
    prompt(s, T(1, 1), 'This session is being continued from a previous conversation (synthetic summary).', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    prompt(s, T(1, 1), '<local-command-caveat>Caveat: synthetic</local-command-caveat>', { isMeta: true }),
    prompt(s, T(1, 1), '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
    prompt(s, T(1, 2), '<local-command-stdout>Compacted</local-command-stdout>'),
  ]);
}

// ---------- E：API 重试中 ----------
{
  const s = SID.E;
  write(`${s}.jsonl`, [
    prompt(s, T(0, 0), 'Retry case'),
    asst(s, T(0, 5), 'msg_e1', [toolUse('toolu_e1', 'Grep', { pattern: 'needle' })], 'tool_use', usage({ input: 10, w1: 500, out: 10 })),
    result(s, T(0, 6), 'toolu_e1', 'found'),
    base(s, 'system', T(0, 20), { subtype: 'api_error', level: 'error', error: { status: 529 }, retryInMs: 5000, retryAttempt: 2, maxRetries: 10 }),
  ]);
}

// ---------- F：529 过载报错 ----------
{
  const s = SID.F;
  write(`${s}.jsonl`, [
    prompt(s, T(0, 0), 'Overload case'),
    base(s, 'assistant', T(0, 40), {
      isApiErrorMessage: true,
      error: 'server_error',
      apiErrorStatus: 529,
      message: { id: 'msg_f_err', type: 'message', role: 'assistant', model: '<synthetic>', content: [text('API Error: 529 Overloaded (synthetic)')], stop_reason: 'stop_sequence', stop_sequence: '', usage: usage({}) },
    }),
  ]);
}

// ---------- G：AskUserQuestion 等回答 ----------
{
  const s = SID.G;
  write(`${s}.jsonl`, [
    prompt(s, T(0, 0), 'Ask me something'),
    asst(s, T(0, 10), 'msg_g1', [toolUse('toolu_ask', 'AskUserQuestion', { questions: [{ question: 'Pick one?' }] })], 'tool_use', usage({ input: 10, w1: 400, out: 30 })),
  ]);
}

// ---------- H：在线会话，挂着 Edit ----------
{
  const s = SID.H;
  write(`${s}.jsonl`, [
    { type: 'ai-title', sessionId: s, aiTitle: 'Live session H' },
    prompt(s, T(0, 0), 'Edit a file'),
    asst(s, T(0, 10), 'msg_h1', [toolUse('toolu_h_edit', 'Edit', { file_path: '/tmp/am-fixture/h.js', old_string: 'a', new_string: 'b' })], 'tool_use', usage({ input: 10, w1: 2000, read: 30000, out: 30 })),
  ]);
}

// ---------- I：老版本（2.1.200）会话，挂着 Read ----------
{
  const s = SID.I;
  const ex = { version: '2.1.200' };
  write(`${s}.jsonl`, [
    prompt(s, T(0, 0), 'Old version read', ex),
    asst(s, T(0, 10), 'msg_i1', [toolUse('toolu_i_read', 'Read', { file_path: '/tmp/am-fixture/i.txt' })], 'tool_use', usage({ input: 10, w5: 400, out: 10 }), 'claude-haiku-4-5-20251001', ex),
  ]);
}

// ---------- J：撞额度文字版 + synthetic “No response requested.” ----------
{
  const s = SID.J;
  const ex = { version: '2.1.215', entrypoint: 'cli' };
  write(`${s}.jsonl`, [
    prompt(s, T(0, 0), 'Text quota case', ex),
    asst(s, T(0, 5), 'msg_j0', [text('No response requested.')], 'stop_sequence', usage({}), '<synthetic>', ex),
    prompt(s, T(0, 6), 'Now really do it', ex),
    asst(s, T(0, 10), 'msg_j1', [thinking()], null, usage({ input: 10, w5: 300, out: 5 }), 'claude-sonnet-4-6', ex),
    base(s, 'assistant', T(0, 12), {
      ...ex,
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiErrorStatus: 429,
      message: { id: 'msg_j_err', type: 'message', role: 'assistant', model: '<synthetic>', content: [text("You've hit your session limit · resets 3:45pm (Asia/Seoul)")], stop_reason: 'stop_sequence', stop_sequence: '', usage: usage({}) },
    }),
  ]);
}

console.log('fixtures written to', OUT);
