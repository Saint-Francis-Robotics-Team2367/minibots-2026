/**
 * A fake MicroPython board speaking the real raw-REPL byte protocol, so
 * serial.js's state machine can be tested without hardware.
 * Modeled on what an ESP32 running boot.py + main.py actually emits.
 */
export class FakeBoard {
  constructor({ rawPaste = true, files = {}, running = true, windowSize = 128 } = {}) {
    this.rawPaste = rawPaste;
    this.files = { ...files };          // name -> Uint8Array
    this.running = running;             // main.py looping (must be interrupted)
    this.windowSize = windowSize;
    this.out = [];                      // bytes we send to the host
    this.state = 'friendly';
    this.pending = '';                  // command bytes being pasted
    this.pasteRemain = 0;
    this.log = [];
  }
  #emit(s) { this.out.push(s); }
  read() { const s = this.out.join(''); this.out = []; return s; }

  write(s) {
    for (const ch of s) this.#byte(ch);
  }

  #byte(c) {
    if (this.state === 'paste-collect') {
      if (c === '\x04') {               // end of data
        this.#emit('\x04');            // ack
        this.state = 'exec';
        this.#runPending();
        return;
      }
      this.pending += c;
      this.pasteRemain--;
      if (this.pasteRemain === 0) {     // grant another window
        this.pasteRemain = this.windowSize;
        this.#emit('\x01');
      }
      return;
    }
    if (this.state === 'raw-collect') {
      if (c === '\x04') { this.#emit('OK'); this.#runPending(); return; }
      this.pending += c; return;
    }
    // At the ">" prompt a real board also takes bytes as the command; this is
    // where the second and later commands land once raw-paste is latched off.
    if (this.state === 'raw-ready' && c !== '\x01' && c !== '\x02' && c !== '\x03'
        && c !== '\x04' && c !== '\x05' && c !== '\r') {
      this.pending = c; this.state = 'raw-collect'; return;
    }
    if (this.state === 'paste-cmd') {
      if (c === 'A') { this.state = 'paste-cmd-a'; }
      return;
    }
    if (this.state === 'paste-cmd-a') {
      if (c === '\x01') {
        if (this.rawPaste) {
          this.#emit('R\x01');
          const w = this.windowSize;
          this.#emit(String.fromCharCode(w & 0xff, (w >> 8) & 0xff));
          this.pasteRemain = w; this.pending = ''; this.state = 'paste-collect';
        } else {
          this.#emit('R\x00');
          this.pending = ''; this.state = 'raw-collect';
        }
      }
      return;
    }
    if (c === '\x03') { this.running = false; this.log.push('interrupt'); return; }
    if (c === '\x01') {
      if (this.state === 'raw-ready' || this.state === 'friendly') {
        this.#emit('\r\nraw REPL; CTRL-B to exit\r\n>');
        this.state = 'awaiting-reset';
      }
      return;
    }
    if (c === '\x02') { this.state = 'friendly'; this.#emit('\r\n>>> '); return; }
    if (c === '\x04') {
      if (this.state === 'awaiting-reset') {
        this.#emit('\r\nsoft reboot\r\n');
        // boot.py prints during the gap — the exact thing mpremote's split await exists for
        this.#emit('[boot] Starting in 1500 ms — press Ctrl-C now to stop for upload.\r\n');
        this.#emit('raw REPL; CTRL-B to exit\r\n>');
        this.state = 'raw-ready';
      }
      return;
    }
    if (c === '\x05') { this.state = 'paste-cmd'; return; }
  }

  /** Execute the collected command the way the board would, then emit 2 EOFs. */
  #runPending() {
    const code = this.pending; this.pending = '';
    this.log.push('exec: ' + code.replace(/\n/g,'\\n').slice(0,70));
    let stdout = '', stderr = '';
    try { stdout = this.#interpret(code); }
    catch (e) { stderr = `Traceback (most recent call last):\r\n  File "<stdin>", line 1\r\n${e.message}\r\n`; }
    this.#emit(stdout + '\x04' + stderr + '\x04>');
    this.state = 'raw-ready';
  }

  /** A tiny interpreter for exactly the commands serial.js sends. */
  #interpret(code) {
    let m;
    if ((m = /^f=open\('([^']*)','rb'\)\nr=f\.read$/.exec(code))) {
      const f = this.files[m[1]];
      if (f === undefined) throw new Error(`OSError: [Errno 2] ENOENT`);
      this._read = { data: f, pos: 0 }; return '';
    }
    if ((m = /^print\(repr\(r\((\d+)\)\)\)$/.exec(code))) {
      const n = Number(m[1]); const r = this._read;
      const chunk = r.data.subarray(r.pos, r.pos + n); r.pos += chunk.length;
      return pyRepr(chunk) + '\r\n';
    }
    if ((m = /^f=open\('([^']*)','wb'\)\nw=f\.write$/.exec(code))) {
      this._write = { name: m[1], parts: [] }; return '';
    }
    if ((m = /^w\((b'[\s\S]*')\)$/.exec(code))) {
      this._write.parts.push(pyParse(m[1])); return '';
    }
    if (code === 'f.close()') {
      if (this._write) {
        const total = this._write.parts.reduce((a,b)=>a+b.length,0);
        const buf = new Uint8Array(total); let at=0;
        for (const p of this._write.parts) { buf.set(p, at); at += p.length; }
        this.files[this._write.name] = buf; this._write = null;
      }
      this._read = null; return '';
    }
    if (/^import os\nfor f in os\.ilistdir\(/.test(code)) {
      return Object.entries(this.files)
        .map(([n,d]) => `('${n}', 32768, 0, ${d.length}),`).join('');
    }
    if ((m = /^import os\ntry:\n os\.stat\('([^']*)'\)\n print\(1\)\nexcept OSError:\n print\(0\)$/.exec(code))) {
      return (this.files[m[1]] !== undefined ? '1' : '0') + '\r\n';
    }
    if ((m = /^print\(repr\(([\s\S]*)\)\)$/.exec(code))) {
      return "'?'\r\n";
    }
    return '';
  }
}

function pyRepr(bytes) {
  let s = "b'";
  for (const b of bytes) {
    if (b === 0x27 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b === 0x0a) s += '\\n';
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x09) s += '\\t';
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += '\\x' + b.toString(16).padStart(2,'0');
  }
  return s + "'";
}
function pyParse(lit) {
  const body = /^b'([\s\S]*)'$/.exec(lit)[1]; const out=[];
  for (let i=0;i<body.length;i++){
    if (body[i] !== '\\') { out.push(body.charCodeAt(i)&0xff); continue; }
    const n = body[++i];
    if (n==='x'){ out.push(parseInt(body.slice(i+1,i+3),16)); i+=2; }
    else if (n==='n') out.push(10); else if (n==='r') out.push(13);
    else if (n==='t') out.push(9); else if (n==='0') out.push(0);
    else out.push(body.charCodeAt(i)&0xff);
  }
  return new Uint8Array(out);
}
