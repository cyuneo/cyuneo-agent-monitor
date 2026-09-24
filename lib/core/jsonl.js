'use strict';
// JsonlTail: incremental jsonl reader driven by byte offsets.
// Behaviour:
// - each poll reads only the bytes appended since the last offset; when nothing changed it does a single stat;
// - lines are split on newline only; a partial line waits for the next poll (a newline byte never appears inside a UTF-8 multi-byte character);
// - reads in 1MB chunks and splits each chunk as it goes, so even the first read of a large file never allocates the whole file size;
// - if the file gets shorter (truncated or rewritten) it starts over and rebuilds the state;
// - opts.prefilter(lineBuf): decides on the raw bytes, before string conversion and JSON.parse, whether a line is wanted; a falsy return skips it;
// - poll(maxBytes): reads at most this many bytes this time (used by the chunked scan for today's totals); the rest is read next time;
// - if the file's inode changes (replaced by a new file) it also starts over.
// Plain Node, no vscode dependency; usable by the worker, the terminal version and the extension.

const fs = require('fs');

const NL = 0x0a;
const CHUNK = 1 << 20; // read at most 1MB at a time
const MAX_LINE = 64 << 20; // a line longer than 64MB is skipped whole: a malformed file must not exhaust memory (normal lines carrying images are only a few MB)

// One read buffer shared by the whole module, allocated once: allocating a fresh one on every poll and dropping it
// leaves the freed memory held by the system allocator inside the process (on macOS tens of MB may never be returned).
// If a feed callback calls another poll (nesting), the inner call temporarily allocates its own buffer
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
   * @param {string} file absolute path
   * @param {() => any} [init] creates the initial state; called again whenever the file starts over
   * @param {(state: any, entry: any) => void} [feed] called once for each parsed line
   * @param {{ prefilter?: (line: Buffer) => boolean, maxLine?: number }} [opts]
   */
  constructor(file, init = emptyState, feed = noop, opts = {}) {
    this.file = file;
    this.init = init;
    this.feed = feed;
    this.prefilter = (opts && opts.prefilter) || null;
    this.maxLine = (opts && opts.maxLine > 0) ? opts.maxLine : MAX_LINE; // tests can lower it
    this.offset = 0;       // byte position read so far
    this.carry = null;     // partial line left from last time (array of Buffers collected per chunk)
    this.carryLen = 0;     // byte length of the partial line
    this.dropping = false; // currently skipping a line longer than MAX_LINE
    this.mtimeMs = 0;
    this.size = 0;         // file size from the most recent stat
    this.ino = 0;
    this.bytesRead = 0;    // bytes read by the most recent poll
    this.lines = 0;        // total lines handed to feed
    this.skipped = 0;      // total lines skipped by prefilter
    this.resets = 0;       // total number of restarts from the beginning
    this.state = init();
  }

  // Start over: reset the offset and rebuild the state
  reset() {
    this.offset = 0;
    this.carry = null;
    this.carryLen = 0;
    this.dropping = false;
    this.state = this.init();
    this.resets++;
  }

  // Bytes not yet read (used for today's-totals progress)
  remaining() {
    return Math.max(0, this.size - this.offset);
  }

  /**
   * Reads new content. Returns whether any line was handed to feed this time (lines skipped by prefilter do not count).
   * @param {number} [maxBytes] max bytes to read this time; defaults to reading to end of file; ≤0 reads nothing (stat only)
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
    if (!(maxBytes > 0)) return false; // budget used up: only update size / mtime, do not read
    let len = st.size - this.offset;
    if (len > maxBytes) len = Math.floor(maxBytes);
    if (!(len > 0)) return false;
    // Read in chunks: at most CHUNK bytes each, splitting lines per chunk. On the first read of a transcript tens of MB in size,
    // peak memory is one chunk rather than the whole file (reading it whole would permanently grow the process's resident memory by hundreds of MB)
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
        if (got < want) break; // the file shrank while being read: handled at the next stat
      }
    } catch {
      // error mid-read: lines already split still count; the rest is read next time
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      giveScratch(buf);
    }
    return fed;
  }

  // Joins the partial line left from the previous chunk and emits complete lines; the trailing partial line is copied out for the next chunk (buf is reused).
  // Partial lines are collected per chunk in an array and concatenated only once a newline arrives, so even multi-MB lines are not copied over and over
  take(chunk) {
    if (this.dropping) {
      // skipping an over-long line: discard up to the next newline
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
    const cut = data.length - (chunk.length - end); // position of the newline within data
    const rest = data.length - cut - 1;
    this.carry = rest > 0 ? [Buffer.from(data.subarray(cut + 1))] : null;
    this.carryLen = rest;
    return this.prefilter ? this.feedFiltered(data, cut) : this.feedAll(data, cut);
  }

  // No prefilter: every line is wanted (decode line by line instead of turning the whole chunk into one big string; Node allocates strings ≥ 1MB separately off-heap)
  feedAll(data, end) {
    return this.feedLines(data, end, null);
  }

  // With prefilter: decide on the bytes first; skipped lines are neither decoded nor parsed
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
 * Builds a prefilter that keeps a line only if it contains any of the substrings. Substrings are compared as UTF-8 bytes.
 * Example: substringFilter('"usage"') only lets through lines containing usage.
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
 * Reads a whole jsonl file in one go (for small files, e.g. the first read of session_index.jsonl). Lines that fail to parse are skipped.
 * @param {string} file
 * @returns {any[]}
 */
function readJsonlSync(file) {
  const tail = new JsonlTail(file, () => [], (arr, e) => { arr.push(e); });
  tail.poll();
  return tail.state;
}

module.exports = { JsonlTail, substringFilter, readJsonlSync, NL, CHUNK, MAX_LINE };
