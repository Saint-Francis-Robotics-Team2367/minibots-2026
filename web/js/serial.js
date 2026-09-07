/**
 * MicroPython raw REPL over Web Serial.
 *
 * Transcribed from mpremote's own source rather than reconstructed, so the
 * browser reproduces a sequence that is known to work against these boards:
 *
 *   mpremote/transport_serial.py:162  enter_raw_repl
 *   mpremote/transport_serial.py:218  raw_paste_write
 *   mpremote/transport_serial.py:252  exec_raw_no_follow
 *   mpremote/transport.py:80/133/154  fs_listdir / fs_readfile / fs_writefile
 *
 * Two mechanics decide whether this works at all:
 *
 *   1. ONE long-lived reader. Alternating getReader()/releaseLock() between
 *      calls drops bytes that arrive between the release and the next acquire,
 *      which shows up as a sentinel that never matches — a hang, not an error.
 *      So the reader is opened once at connect() and pumps into a buffer that
 *      the await helpers below consume.
 *   2. Exactly one port owner. esptool-js calls port.open() itself and holds
 *      port.readable.getReader() for its whole lifetime, so it cannot share a
 *      port with this module. close() here must fully release before esptool
 *      takes over. See the ownership guard in esptool.js.
 */

/* ── Sentinels ──────────────────────────────────────────────────────────── */
const CTRL_A = "\x01"; // raw REPL
const CTRL_B = "\x02"; // friendly REPL
const CTRL_C = "\x03"; // interrupt
const CTRL_D = "\x04"; // soft reset / EOF
const CTRL_E = "\x05"; // paste mode

const RAW_PROMPT = "raw REPL; CTRL-B to exit\r\n>";
const RAW_BANNER = "raw REPL; CTRL-B to exit\r\n";
const SOFT_REBOOT = "soft reboot\r\n";

/** mpremote's chunk size for both directions (transport.py:133/154). */
const CHUNK = 256;

/**
 * Attempts and spacing mirror flash-robot.sh:190 — the retry loop that exists
 * because boot.py's interruptible window is only 1500 ms wide and the Ctrl-C has
 * to land inside it.
 */
export const RETRY_ATTEMPTS = 5;
export const RETRY_DELAY_MS = 1000;

/** What flash-robot.sh prints when it runs out of attempts. Same words here. */
export const REMEDIATION =
  "Could not reach the robot's REPL. Try again, or hold the BOOT button while " +
  "connecting, or reflash MicroPython.";

export class SerialError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MicroPythonSerial {
  constructor() {
    /** @type {SerialPort | null} */
    this.port = null;
    /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
    this.reader = null;
    /** @type {WritableStreamDefaultWriter<Uint8Array> | null} */
    this.writer = null;
    /** Bytes read but not yet consumed by an await helper. */
    this.buf = "";
    /** Set once the board has answered the raw-REPL banner. */
    this.inRaw = false;
    /**
     * Raw-paste is negotiated once per connection and the answer remembered,
     * matching mpremote's `use_raw_paste` latch: a board that answered "R\x00"
     * must not be asked again on every exec.
     */
    this.useRawPaste = true;
    this.pump = null;
    this.enc = new TextEncoder();
    /** Latin1, not UTF-8: this is a byte protocol and a multi-byte sequence
     *  split across two reads would decode to a replacement char and corrupt a
     *  sentinel match. Bytes map 1:1 to code units 0-255 instead. */
    this.dec = new TextDecoder("latin1");
  }

  /* ── Connection ───────────────────────────────────────────────────────── */

  /** @returns {boolean} */
  static get supported() {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  /**
   * Ports this origin already has permission for. Needs no user gesture, so a
   * returning student does not re-pick the board.
   * @returns {Promise<SerialPort[]>}
   */
  static async granted() {
    if (!MicroPythonSerial.supported) {
      return [];
    }
    try {
      return await navigator.serial.getPorts();
    } catch (err) {
      return [];
    }
  }

  /** Show the picker. Requires a user gesture, like WebHID's requestDevice. */
  static async request() {
    if (!MicroPythonSerial.supported) {
      throw new SerialError("This browser has no Web Serial. Use Chrome or Edge.");
    }
    return navigator.serial.requestPort();
  }

  /**
   * @param {SerialPort} port
   * @param {number} [baudRate] 115200 is MicroPython's REPL rate.
   */
  async connect(port, baudRate = 115200) {
    if (this.port) {
      throw new SerialError("Already connected");
    }
    await port.open({ baudRate });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.buf = "";
    this.inRaw = false;
    this.useRawPaste = true;
    // One pump for the connection's whole life. Never awaited here — it runs
    // until the reader is cancelled by close().
    this.pump = this.#pumpLoop();
  }

  async #pumpLoop() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) {
          return;
        }
        if (value && value.length) {
          this.buf += this.dec.decode(value, { stream: true });
        }
      }
    } catch (err) {
      // Cancelled by close(), or the device vanished. Either way the awaiters
      // below time out with a message, which is better than a rejected read
      // surfacing as an unhandled rejection.
    }
  }

  /**
   * Release everything, in the order that actually frees the port.
   *
   * cancel() before releaseLock() — a locked stream cannot be released, and a
   * port whose readable stays locked cannot be reopened by esptool-js. This is
   * the failure that presents as a silent hang.
   */
  async close() {
    if (!this.port) {
      return;
    }
    try {
      if (this.inRaw) {
        // Leave the board in the friendly REPL rather than raw mode, so a person
        // opening a terminal next sees a prompt they recognise.
        await this.#write("\r" + CTRL_B).catch(() => {});
        this.inRaw = false;
      }
    } catch (err) {
      /* the board may already be gone; closing matters more */
    }
    try {
      await this.reader?.cancel();
    } catch (err) {
      /* already cancelled */
    }
    try {
      this.reader?.releaseLock();
    } catch (err) {
      /* already released */
    }
    try {
      await this.writer?.close();
    } catch (err) {
      /* already closed */
    }
    try {
      this.writer?.releaseLock();
    } catch (err) {
      /* already released */
    }
    await this.pump?.catch(() => {});
    try {
      await this.port.close();
    } catch (err) {
      /* already closed */
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.pump = null;
    this.buf = "";
  }

  /* ── Byte plumbing ────────────────────────────────────────────────────── */

  /** @param {string} s Latin1 — one code unit per byte. */
  async #write(s) {
    if (!this.writer) {
      throw new SerialError("Not connected");
    }
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      bytes[i] = s.charCodeAt(i) & 0xff;
    }
    await this.writer.write(bytes);
  }

  /**
   * Read until `needle` appears, and consume through it.
   *
   * @param {string} needle
   * @param {number} [timeoutMs]
   * @returns {Promise<string>} everything before the needle
   */
  async #readUntil(needle, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.buf.indexOf(needle);
      if (at !== -1) {
        const head = this.buf.slice(0, at);
        this.buf = this.buf.slice(at + needle.length);
        return head;
      }
      if (Date.now() > deadline) {
        throw new SerialError(
          `Timed out waiting for ${JSON.stringify(needle)} — got ${JSON.stringify(
            this.buf.slice(-120),
          )}`,
        );
      }
      await sleep(10);
    }
  }

  /** Read exactly n bytes. */
  async #readExactly(n, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (Date.now() > deadline) {
        throw new SerialError(`Timed out waiting for ${n} bytes`);
      }
      await sleep(5);
    }
    const head = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return head;
  }

  /* ── Raw REPL ─────────────────────────────────────────────────────────── */

  /**
   * Enter the raw REPL. Sequence and the reason for its shape are mpremote's
   * (transport_serial.py:162).
   *
   * @param {{ softReset?: boolean, timeoutMs?: number }} [opts]
   */
  async enterRaw({ softReset = true, timeoutMs = 5000 } = {}) {
    // Note the leading \r: a bare \x03 can be swallowed when the board is
    // mid-line, and main.py's tight loop leaves very little else to land in.
    await this.#write("\r" + CTRL_C);
    await sleep(120);
    this.buf = ""; // mpremote flushes input here too
    await this.#write("\r" + CTRL_A);

    if (softReset) {
      await this.#readUntil(RAW_PROMPT, timeoutMs);
      await this.#write(CTRL_D);
      // Awaited separately from the banner, deliberately: that is what lets
      // boot.py's own output through between the two, instead of it landing
      // inside the sentinel we are matching.
      await this.#readUntil(SOFT_REBOOT, timeoutMs);
    }
    await this.#readUntil(RAW_BANNER, timeoutMs);
    this.inRaw = true;
  }

  /**
   * enterRaw with the retry policy the shell script uses, because the window
   * boot.py opens is 1500 ms and the first Ctrl-C often misses it.
   *
   * @param {(msg: string) => void} [onAttempt]
   */
  async enterRawWithRetry(onAttempt) {
    let last;
    for (let i = 1; i <= RETRY_ATTEMPTS; i++) {
      try {
        await this.enterRaw();
        return;
      } catch (err) {
        last = err;
        onAttempt?.(`REPL attempt ${i} of ${RETRY_ATTEMPTS} failed`);
        if (i < RETRY_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
    throw new SerialError(`${REMEDIATION} (${last?.message ?? "unknown error"})`);
  }

  async exitRaw() {
    await this.#write("\r" + CTRL_B);
    this.inRaw = false;
  }

  /**
   * Run `code` and return [stdout, stderr].
   *
   * @param {string} code
   * @param {{ timeoutMs?: number, onOutput?: (chunk: string) => void }} [opts]
   * @returns {Promise<[string, string]>}
   */
  async exec(code, { timeoutMs = 10000, onOutput } = {}) {
    await this.#writeCommand(code);
    return this.#follow(timeoutMs, onOutput);
  }

  /**
   * exec, but raise on anything the board wrote to stderr. Most callers want
   * this: a traceback returned as a value is a traceback nobody notices.
   */
  async execOrThrow(code, opts) {
    const [out, err] = await this.exec(code, opts);
    if (err) {
      throw new SerialError(err.trim());
    }
    return out;
  }

  /**
   * Evaluate an expression and return the parsed repr.
   *
   * mpremote does `print(repr(expr))` and runs ast.literal_eval on the result
   * (transport_serial.py:296). There is no literal_eval here, so the two shapes
   * this project needs are parsed explicitly: a bytes literal from a file read,
   * and a plain integer.
   */
  async evalRepr(expression) {
    return (await this.execOrThrow(`print(repr(${expression}))`)).trim();
  }

  /** @param {string} code */
  async #writeCommand(code) {
    if (!this.inRaw) {
      throw new SerialError("Not in raw REPL");
    }
    // The board prints ">" when it is ready for a command.
    await this.#readUntil(">", 5000);

    if (this.useRawPaste) {
      await this.#write(CTRL_E + "A" + CTRL_A);
      const resp = await this.#readExactly(2);
      if (resp === "R" + CTRL_A) {
        return this.#rawPasteWrite(code);
      }
      if (resp !== "R\x00") {
        // Not a raw-paste-aware board: it read \x05 as paste mode and echoed the
        // banner. mpremote discards the tail and falls back.
        await this.#readUntil("w REPL; CTRL-B to exit\r\n>", 5000);
      }
      // Either answer means: never ask again on this connection.
      this.useRawPaste = false;
    }

    // Plain raw REPL: 256 bytes every 10 ms, then EOF.
    for (let i = 0; i < code.length; i += CHUNK) {
      await this.#write(code.slice(i, i + CHUNK));
      await sleep(10);
    }
    await this.#write(CTRL_D);
    const ok = await this.#readExactly(2);
    if (ok !== "OK") {
      throw new SerialError(`Could not exec (response ${JSON.stringify(ok)})`);
    }
  }

  /**
   * Raw-paste write with the device's flow control honored
   * (transport_serial.py:218). The window size is the device telling us how much
   * it can buffer; ignoring it overruns the board and truncates the code.
   */
  async #rawPasteWrite(code) {
    const hdr = await this.#readExactly(2);
    const windowSize = hdr.charCodeAt(0) | (hdr.charCodeAt(1) << 8);
    let windowRemain = windowSize;

    let i = 0;
    while (i < code.length) {
      while (windowRemain === 0 || this.buf.length) {
        const b = await this.#readExactly(1);
        if (b === CTRL_A) {
          windowRemain += windowSize;
        } else if (b === CTRL_D) {
          // Abrupt end — acknowledge and stop, as mpremote does.
          await this.#write(CTRL_D);
          return;
        } else {
          throw new SerialError(`Unexpected byte during raw paste: ${JSON.stringify(b)}`);
        }
      }
      const slice = code.slice(i, i + windowRemain);
      await this.#write(slice);
      windowRemain -= slice.length;
      i += slice.length;
    }
    await this.#write(CTRL_D);
    await this.#readUntil(CTRL_D, 10000);
  }

  /**
   * Collect output up to the two EOFs: stdout, then stderr
   * (transport_serial.py:202).
   *
   * @param {number} timeoutMs
   * @param {(chunk: string) => void} [onOutput]
   */
  async #follow(timeoutMs, onOutput) {
    let out;
    if (onOutput) {
      // Stream as it arrives rather than after the fact, so a student watching
      // a long-running main.py sees print() output while it happens.
      out = await this.#readUntilStreaming(CTRL_D, timeoutMs, onOutput);
    } else {
      out = await this.#readUntil(CTRL_D, timeoutMs);
    }
    const err = await this.#readUntil(CTRL_D, timeoutMs);
    return [out, err];
  }

  /** #readUntil, handing each new slice to a callback as it lands. */
  async #readUntilStreaming(needle, timeoutMs, onOutput) {
    const deadline = Date.now() + timeoutMs;
    let emitted = 0;
    for (;;) {
      const at = this.buf.indexOf(needle);
      if (at !== -1) {
        if (at > emitted) {
          onOutput(this.buf.slice(emitted, at));
        }
        const head = this.buf.slice(0, at);
        this.buf = this.buf.slice(at + needle.length);
        return head;
      }
      if (this.buf.length > emitted) {
        onOutput(this.buf.slice(emitted));
        emitted = this.buf.length;
      }
      if (Date.now() > deadline) {
        throw new SerialError("Timed out waiting for output to end");
      }
      await sleep(30);
    }
  }

  /* ── File operations ──────────────────────────────────────────────────── */

  /**
   * Read a file as bytes (transport.py:133).
   *
   * @param {string} path
   * @param {(read: number) => void} [onProgress]
   * @returns {Promise<Uint8Array>}
   */
  async readFile(path, onProgress) {
    const chunks = [];
    let total = 0;
    await this.execOrThrow(`f=open(${q(path)},'rb')\nr=f.read`);
    try {
      for (;;) {
        const repr = await this.evalRepr(`r(${CHUNK})`);
        const bytes = parseBytesRepr(repr);
        if (!bytes.length) {
          break;
        }
        chunks.push(bytes);
        total += bytes.length;
        onProgress?.(total);
      }
    } finally {
      await this.exec("f.close()").catch(() => {});
    }
    const outp = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      outp.set(c, at);
      at += c.length;
    }
    return outp;
  }

  /** Read a file as text. */
  async readTextFile(path, onProgress) {
    return new TextDecoder().decode(await this.readFile(path, onProgress));
  }

  /**
   * Write a file (transport.py:154). Chunked because a whole main.py in one exec
   * would exceed the board's RAM for the command string.
   *
   * @param {string} path
   * @param {Uint8Array | string} data
   * @param {(written: number, total: number) => void} [onProgress]
   */
  async writeFile(path, data, onProgress) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.execOrThrow(`f=open(${q(path)},'wb')\nw=f.write`);
    try {
      let written = 0;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const chunk = bytes.subarray(i, i + CHUNK);
        await this.execOrThrow(`w(${bytesLiteral(chunk)})`);
        written += chunk.length;
        onProgress?.(written, bytes.length);
      }
    } finally {
      await this.exec("f.close()").catch(() => {});
    }
  }

  /**
   * List a directory (transport.py:80). Parsed host-side, so the board only has
   * to print reprs.
   *
   * @returns {Promise<{name: string, type: number, size: number}[]>}
   */
  async listDir(path = "") {
    const arg = path ? q(path) : "";
    const out = await this.execOrThrow(
      `import os\nfor f in os.ilistdir(${arg}):\n print(repr(f), end=',')`,
    );
    const entries = [];
    // Tuples look like ('main.py', 32768, 0, 1234). A regex is enough — the
    // board's repr output is machine-generated and this shape is fixed.
    const re = /\(\s*'([^']*)'\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(-?\d+))?\s*\)/g;
    let m;
    while ((m = re.exec(out.replace(/\x04/g, "")))) {
      entries.push({ name: m[1], type: Number(m[2]), size: m[4] ? Number(m[4]) : 0 });
    }
    return entries;
  }

  /** @param {string} path */
  async exists(path) {
    const out = await this.execOrThrow(
      `import os\ntry:\n os.stat(${q(path)})\n print(1)\nexcept OSError:\n print(0)`,
    );
    return out.trim().endsWith("1");
  }

  /** @param {string} path */
  async remove(path) {
    await this.execOrThrow(`import os\nos.remove(${q(path)})`);
  }

  /**
   * Soft reset out of the raw REPL, so main.py actually starts.
   *
   * Ctrl-B first: a Ctrl-D inside the raw REPL re-enters raw mode rather than
   * running the program.
   */
  async softReset() {
    await this.#write("\r" + CTRL_B);
    this.inRaw = false;
    this.useRawPaste = true;
    await sleep(80);
    this.buf = "";
    await this.#write(CTRL_D);
  }

  /**
   * Stream whatever the board prints, until stopped.
   *
   * Read-only by design — there is no input path, so nothing here can answer an
   * input() prompt. Must be stopped before the next exec: both want the buffer,
   * and leaving this running deadlocks the next command.
   *
   * @param {(chunk: string) => void} onOutput
   * @returns {() => void} stop
   */
  streamOutput(onOutput) {
    let running = true;
    (async () => {
      while (running) {
        if (this.buf.length) {
          onOutput(this.buf);
          this.buf = "";
        }
        await sleep(60);
      }
    })();
    return () => {
      running = false;
    };
  }
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

/** Single-quote a path for embedding in a Python literal. */
function q(s) {
  return `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Render bytes as a Python bytes literal.
 *
 * Everything outside printable ASCII goes out as \xNN, and the quote and
 * backslash are escaped: a robot file is arbitrary bytes, and one unescaped
 * quote would end the literal early and write a truncated file.
 *
 * @param {Uint8Array} bytes
 */
export function bytesLiteral(bytes) {
  let s = "b'";
  for (const b of bytes) {
    if (b === 0x27 || b === 0x5c) {
      s += "\\" + String.fromCharCode(b);
    } else if (b >= 0x20 && b < 0x7f) {
      s += String.fromCharCode(b);
    } else {
      s += "\\x" + b.toString(16).padStart(2, "0");
    }
  }
  return s + "'";
}

/**
 * Parse the bytes repr MicroPython prints for a chunk of file.
 *
 * Handles the escapes repr() actually emits: \xNN, \n, \r, \t, \\, \', \" and
 * \0. Anything else is taken literally.
 *
 * @param {string} repr
 * @returns {Uint8Array}
 */
export function parseBytesRepr(repr) {
  const s = repr.trim();
  const m = /^b(['"])([\s\S]*)\1$/.exec(s);
  if (!m) {
    if (s === "b''" || s === 'b""' || s === "") {
      return new Uint8Array(0);
    }
    throw new SerialError(`Not a bytes literal: ${JSON.stringify(s.slice(0, 60))}`);
  }
  const body = m[2];
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      out.push(body.charCodeAt(i) & 0xff);
      continue;
    }
    const n = body[++i];
    if (n === "x") {
      out.push(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === "n") {
      out.push(0x0a);
    } else if (n === "r") {
      out.push(0x0d);
    } else if (n === "t") {
      out.push(0x09);
    } else if (n === "0") {
      out.push(0x00);
    } else {
      // \\ , \' , \" and anything else: the character itself.
      out.push(body.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(out);
}
