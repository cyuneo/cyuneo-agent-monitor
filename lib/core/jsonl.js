'use strict';
// JsonlTail：按字节偏移增量读 jsonl。
// 从 v0.2 monitor.js 的 TranscriptReader 搬来，行为不变：
// - 每次 poll 只读上次偏移之后新增的字节；没变化时只做一次 stat；
// - 只按换行切，半行留到下次（换行字节不会出现在 UTF-8 多字节字符中间）；
// - 按 1MB 一块读，读一块切一块，大文件第一次读也不按整份文件大小申请内存；
// - 文件变短（被截断或重写）就从头来，并重建状态。
// 新增：
// - opts.prefilter(lineBuf)：在转字符串、JSON.parse 之前按字节判断要不要这一行，返回假值就跳过；
// - poll(maxBytes)：本次最多读这么多字节（今日合计分片扫描用），读不完下次继续；
// - 文件 inode 变了（被替换成新文件）也从头来。
// 纯 Node，不依赖 vscode；worker、终端版、扩展都能用。

const fs = require('fs');

const NL = 0x0a;
const CHUNK = 1 << 20; // 每次最多读 1MB
const MAX_LINE = 64 << 20; // 一行超过 64MB 就整行跳过：异常文件不能把内存吃光（正常记录里带图片的行也只有几 MB）

// 读缓冲区全模块共用一块，只申请一次：每次 poll 都新申请再丢掉的话，
// 系统分配器会把释放掉的内存留在进程里（macOS 上实测几十 MB 退不回去）。
// feed 回调里又调了别的 poll（嵌套）时，里层临时另申请一块
let scratch = null;
let scratchBusy = false;
function takeScratch(len) {
  if (scratchBusy) return Buffer.allocUnsafe(Math.min(len, CHUNK));
  if (!scratch) scratch = Buffer.allocUnsafeSlow(CHUNK);
  scratchBusy = true;
  return scratch;
}
function giveScratch(buf) {
  if (buf === scratch) scratchBusy = false;
}

function noop() {}
function emptyState() { return {}; }

class JsonlTail {
  /**
   * @param {string} file 绝对路径
   * @param {() => any} [init] 生成初始状态；文件重来时会再调用一次
   * @param {(state: any, entry: any) => void} [feed] 每解析出一行调用一次
   * @param {{ prefilter?: (line: Buffer) => boolean, maxLine?: number }} [opts]
   */
  constructor(file, init = emptyState, feed = noop, opts = {}) {
    this.file = file;
    this.init = init;
    this.feed = feed;
    this.prefilter = (opts && opts.prefilter) || null;
    this.maxLine = (opts && opts.maxLine > 0) ? opts.maxLine : MAX_LINE; // 测试可以调小
    this.offset = 0;       // 已读到的字节位置
    this.carry = null;     // 上次剩下的半行（按块攒的 Buffer 数组）
    this.carryLen = 0;     // 半行的字节数
    this.dropping = false; // 正在跳过一条超过 MAX_LINE 的行
    this.mtimeMs = 0;
    this.size = 0;         // 最近一次 stat 的文件大小
    this.ino = 0;
    this.bytesRead = 0;    // 最近一次 poll 读了多少字节
    this.lines = 0;        // 累计交给 feed 的行数
    this.skipped = 0;      // 累计被 prefilter 跳过的行数
    this.resets = 0;       // 累计从头重来的次数
    this.state = init();
  }

  // 从头来：偏移清零、状态重建
  reset() {
    this.offset = 0;
    this.carry = null;
    this.carryLen = 0;
    this.dropping = false;
    this.state = this.init();
    this.resets++;
  }

  // 还没读的字节数（今日合计算进度用）
  remaining() {
    return Math.max(0, this.size - this.offset);
  }

  /**
   * 读取新增内容。返回本次是否有行交给了 feed（被 prefilter 跳过的不算）。
   * @param {number} [maxBytes] 本次最多读多少字节；默认读到文件末尾；≤0 时不读（只 stat）
   */
  poll(maxBytes = Infinity) {
    this.bytesRead = 0;
    let st;
    try { st = fs.statSync(this.file); } catch { return false; }
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    const ino = st.ino || 0;
    if (st.size < this.offset || (this.ino && ino && ino !== this.ino)) this.reset();
    this.ino = ino;
    if (st.size === this.offset) return false;
    if (!(maxBytes > 0)) return false; // 预算用完：只更新 size / mtime，不读
    let len = st.size - this.offset;
    if (len > maxBytes) len = Math.floor(maxBytes);
    if (!(len > 0)) return false;
    // 分块读：每块最多 CHUNK 字节，读一块切一块行。几十 MB 的记录第一次读时，
    // 内存峰值是一块的大小，而不是整份文件（整份读会让进程常驻内存涨上百 MB 且退不回去）
    const buf = takeScratch(len);
    let fed = false;
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      while (this.bytesRead < len) {
        const want = Math.min(buf.length, len - this.bytesRead);
        let got = 0;
        while (got < want) {
          const n = fs.readSync(fd, buf, got, want - got, this.offset + got);
          if (n <= 0) break;
          got += n;
        }
        if (got === 0) break;
        this.offset += got;
        this.bytesRead += got;
        if (this.take(buf.subarray(0, got))) fed = true;
        if (got < want) break; // 文件在读的过程中变短了：下次 stat 时处理
      }
    } catch {
      // 读到一半出错：已经切出的行照常算，剩下的下次再读
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
      giveScratch(buf);
    }
    return fed;
  }

  // 接上一块剩下的半行，交出完整的行；最后的半行复制出来留到下一块（buf 会被复用）。
  // 半行按块攒在数组里，遇到换行时才拼一次：几 MB 的超长行也不会反复整段复制
  take(chunk) {
    if (this.dropping) {
      // 正在跳过一整条超长行：丢到下一个换行为止
      const nl = chunk.indexOf(NL);
      if (nl < 0) return false;
      this.dropping = false;
      this.skipped++;
      chunk = chunk.subarray(nl + 1);
      if (!chunk.length) return false;
    }
    const end = chunk.lastIndexOf(NL);
    if (end < 0) {
      this.carryLen += chunk.length;
      if (this.carryLen > this.maxLine) {
        this.carry = null;
        this.carryLen = 0;
        this.dropping = true;
        return false;
      }
      (this.carry || (this.carry = [])).push(Buffer.from(chunk));
      return false;
    }
    const data = this.carry ? Buffer.concat([...this.carry, chunk]) : chunk;
    const cut = data.length - (chunk.length - end); // 换行在 data 里的位置
    const rest = data.length - cut - 1;
    this.carry = rest > 0 ? [Buffer.from(data.subarray(cut + 1))] : null;
    this.carryLen = rest;
    return this.prefilter ? this.feedFiltered(data, cut) : this.feedAll(data, cut);
  }

  // 没有 prefilter：每一行都要（逐行解码，不把整块转成一个大字符串：≥ 1MB 的字符串 Node 会放到堆外单独申请）
  feedAll(data, end) {
    return this.feedLines(data, end, null);
  }

  // 有 prefilter：先在字节上判断，被跳过的行不解码、不解析
  feedFiltered(data, end) {
    return this.feedLines(data, end, this.prefilter);
  }

  feedLines(data, end, prefilter) {
    let fed = false;
    let start = 0;
    while (start < end) {
      let nl = data.indexOf(NL, start);
      if (nl < 0 || nl > end) nl = end;
      if (nl > start) {
        const line = data.subarray(start, nl);
        if (prefilter && !prefilter(line)) {
          this.skipped++;
        } else {
          let e;
          try { e = JSON.parse(line.toString('utf8')); } catch { e = undefined; }
          if (e && typeof e === 'object') {
            this.lines++;
            this.feed(this.state, e);
            fed = true;
          }
        }
      }
      start = nl + 1;
    }
    return fed;
  }
}

/**
 * 生成“行里含任一子串才要”的 prefilter。子串按 UTF-8 字节比较。
 * 例：substringFilter('"usage"') 只放行带 usage 的行。
 * @param {...string} needles
 * @returns {(line: Buffer) => boolean}
 */
function substringFilter(...needles) {
  const bufs = needles.flat().filter(Boolean).map((s) => Buffer.from(String(s), 'utf8'));
  if (!bufs.length) return () => true;
  if (bufs.length === 1) { const b = bufs[0]; return (line) => line.includes(b); }
  return (line) => { for (const b of bufs) if (line.includes(b)) return true; return false; };
}

/**
 * 一次性读完整个 jsonl（小文件用，如 session_index.jsonl 首次读取）。解析失败的行跳过。
 * @param {string} file
 * @returns {any[]}
 */
function readJsonlSync(file) {
  const tail = new JsonlTail(file, () => [], (arr, e) => { arr.push(e); });
  tail.poll();
  return tail.state;
}

module.exports = { JsonlTail, substringFilter, readJsonlSync, NL, CHUNK, MAX_LINE };
