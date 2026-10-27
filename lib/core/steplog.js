'use strict';
// The call log of one step (tool call) in a transcript, read when the user opens its block in the details.
// - Finds the call by its id: Claude Code tool_use.id / tool_result.tool_use_id, Codex call_id; one pass over the file,
//   reading 1MB at a time; a line is parsed only when its raw bytes contain the id, and the read stops once both halves are found.
// - Returns the input (a shell command as is, anything else as indented JSON) and the output text, each clipped to maxChars.
// - Read-only and on demand: nothing is kept between calls.
// Plain Node, no vscode dependency.

const fs = require('fs');

const CHUNK = 1 << 20;
const MAX_LINE = 64 << 20; // same limit as core/jsonl: a longer line is skipped
const MAX_CHARS = 8000;

/**
 * @param {string} file absolute path of a .jsonl transcript
 * @param {string} ref the tool call id
 * @param {{ maxChars?: number }} [opts]
 * @returns {Promise<{ found: boolean, tool: string|null, input: string|null, inputTruncated: boolean,
 *   output: string|null, outputTruncated: boolean, isError: boolean }>}
 */
async function readStep(file, ref, opts = {}) {
  const max = opts.maxChars || MAX_CHARS;
  const out = { found: false, tool: null, input: null, inputTruncated: false, output: null, outputTruncated: false, isError: false };
  if (typeof ref !== 'string' || !ref) return out;
  const needle = Buffer.from(JSON.stringify(ref)); // with its quotes, so one id is not found inside a longer one
  let call = null;
  let result = null;
  const onLine = (buf) => {
    if (buf.indexOf(needle) < 0) return;
    let e;
    try { e = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!call) call = findCall(e, ref);
    if (!result) result = findResult(e, ref);
  };
  const fh = await fs.promises.open(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let rest = null;
    let skipping = false; // inside a line longer than MAX_LINE
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, CHUNK, null);
      if (!bytesRead) break;
      let buf = chunk.subarray(0, bytesRead);
      let start = 0;
      for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, start)) {
        if (skipping) skipping = false;
        else onLine(rest ? Buffer.concat([rest, buf.subarray(start, nl)]) : buf.subarray(start, nl));
        rest = null;
        start = nl + 1;
        if (call && result) return finish(out, call, result, max);
      }
      if (skipping) continue;
      const tail = buf.subarray(start);
      rest = rest ? Buffer.concat([rest, tail]) : Buffer.from(tail);
      if (rest.length > MAX_LINE) { rest = null; skipping = true; }
    }
    if (rest && !skipping) onLine(rest);
  } finally {
    await fh.close();
  }
  return finish(out, call, result, max);
}

// Claude Code: assistant message content[] tool_use; Codex: response_item payload function_call / custom_tool_call / local_shell_call
function findCall(e, ref) {
  const content = e && e.message && Array.isArray(e.message.content) ? e.message.content : null;
  if (content) {
    for (const c of content) {
      if (c && c.type === 'tool_use' && c.id === ref) return { tool: typeof c.name === 'string' ? c.name : null, input: c.input };
    }
  }
  const p = e && e.payload;
  if (p && (p.call_id === ref || p.id === ref) && /_call$/.test(String(p.type || '')) && !/_output$/.test(String(p.type))) {
    let input = p.arguments !== undefined ? p.arguments : (p.input !== undefined ? p.input : p.action);
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* a custom tool's raw input stays text */ } }
    return { tool: typeof p.name === 'string' ? p.name : (p.type === 'local_shell_call' ? 'shell' : null), input };
  }
  return null;
}

// Claude Code: user message content[] tool_result; Codex: payload function_call_output / custom_tool_call_output
function findResult(e, ref) {
  const content = e && e.message && Array.isArray(e.message.content) ? e.message.content : null;
  if (content) {
    for (const c of content) {
      if (c && c.type === 'tool_result' && c.tool_use_id === ref) return { text: textOf(c.content), isError: c.is_error === true };
    }
  }
  const p = e && e.payload;
  if (p && p.call_id === ref && /_output$/.test(String(p.type || ''))) {
    let o = p.output;
    // Codex often stores {"output": "...", "metadata": {...}} as a JSON string
    if (typeof o === 'string' && o.startsWith('{')) { try { const j = JSON.parse(o); if (j && typeof j.output === 'string') o = j; } catch { /* plain text */ } }
    const text = o && typeof o === 'object' && !Array.isArray(o) && typeof o.output === 'string' ? o.output : textOf(o);
    return { text, isError: false };
  }
  return null;
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x.text === 'string' ? x.text : (x && x.type === 'image' ? '[image]' : ''))).filter(Boolean).join('\n');
  if (typeof v === 'object' && typeof v.content === 'string') return v.content;
  return pretty(v);
}

// A shell command is shown as the command itself; everything else as indented JSON
function inputText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && !Array.isArray(input)) {
    const cmd = input.command !== undefined ? input.command : input.cmd;
    if (typeof cmd === 'string' && Object.keys(input).every((k) => k === 'command' || k === 'cmd' || k === 'description' || k === 'timeout' || k === 'workdir')) return cmd;
    if (Array.isArray(cmd) && cmd.every((x) => typeof x === 'string')) return cmd.join(' ');
  }
  return pretty(input);
}

function pretty(v) {
  try { return JSON.stringify(v, null, 2) || ''; } catch { return String(v); }
}

function clip(s, max) {
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}

function finish(out, call, result, max) {
  if (call) {
    const c = clip(inputText(call.input), max);
    Object.assign(out, { found: true, tool: call.tool, input: c.text, inputTruncated: c.truncated });
  }
  if (result) {
    const r = clip(result.text, max);
    Object.assign(out, { found: true, output: r.text, outputTruncated: r.truncated, isError: result.isError });
  }
  return out;
}

module.exports = { readStep, _internal: { findCall, findResult, inputText } };
