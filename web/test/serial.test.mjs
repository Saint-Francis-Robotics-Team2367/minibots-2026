import { FakeBoard } from './fake-board.mjs';
const { MicroPythonSerial } = await import('../js/serial.js');

/** A Web Serial-shaped port backed by FakeBoard. */
function fakePort(board) {
  let closed = false, cancelled = false;
  return {
    _board: board,
    async open() {},
    async close() { closed = true; },
    readable: {
      getReader() {
        return {
          async read() {
            for (;;) {
              if (cancelled) return { done: true };
              const s = board.read();
              if (s) return { value: Uint8Array.from(s, c => c.charCodeAt(0) & 0xff), done: false };
              await new Promise(r => setTimeout(r, 2));
            }
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
    writable: {
      getWriter() {
        return {
          async write(bytes) { board.write(String.fromCharCode(...bytes)); },
          async close() {}, releaseLock() {},
        };
      },
    },
  };
}

const MAIN = `print("hi")\nfor i in range(3):\n    print(i, 'x' , "y")\n# ünïcödé ✓\n`;
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); } };

for (const rawPaste of [true, false]) {
  console.log(`\n=== raw-paste ${rawPaste ? 'SUPPORTED (R\\x01)' : 'UNSUPPORTED (R\\x00 fallback)'} ===`);
  const board = new FakeBoard({
    rawPaste,
    files: { 'main.py': new TextEncoder().encode(MAIN),
             'calib.json': new TextEncoder().encode('{"nl": 1480, "nr": 1712}') },
    windowSize: 64,   // deliberately small: forces multiple flow-control windows
  });
  const mp = new MicroPythonSerial();
  await mp.connect(fakePort(board));

  await mp.enterRaw();
  ok('enterRaw reaches raw mode', mp.inRaw === true);
  ok('interrupt was sent (main.py stopped)', board.log.includes('interrupt'));

  const text = await mp.readTextFile('main.py');
  ok('readFile round-trips main.py exactly', text === MAIN,
     `\n    want ${JSON.stringify(MAIN)}\n    got  ${JSON.stringify(text)}`);

  const calib = await mp.readTextFile('calib.json');
  ok('readFile calib.json', calib === '{"nl": 1480, "nr": 1712}', JSON.stringify(calib));

  // Write a file with every escape hazard in it, then read it back.
  const tricky = `x = 'quote'\ny = "dquote"\nz = back\\slash\n\ttab\r\nnull\x00byte\nünïcödé ✓\n`;
  await mp.writeFile('main.py', tricky);
  const back = await mp.readTextFile('main.py');
  ok('writeFile survives quotes/backslash/NUL/unicode', back === tricky,
     `\n    want ${JSON.stringify(tricky)}\n    got  ${JSON.stringify(back)}`);

  // A file larger than one 256-byte chunk AND several flow-control windows.
  const big = Array.from({length: 400}, (_,i) => `line ${i} — ünïcödé\n`).join('');
  await mp.writeFile('big.py', big);
  const bigBack = await mp.readTextFile('big.py');
  ok(`multi-chunk write/read (${big.length} bytes)`, bigBack === big,
     bigBack.length + ' vs ' + big.length);

  const ls = await mp.listDir();
  const names = ls.map(e => e.name).sort().join(',');
  ok('listDir names', names === 'big.py,calib.json,main.py', names);
  // The board reports BYTES; big.length is JS UTF-16 code units, and the em dash
  // plus the accented letters make those differ.
  const bigBytes = new TextEncoder().encode(big).length;
  ok(`listDir reports byte size (${bigBytes})`,
     ls.find(e=>e.name==='big.py').size === bigBytes,
     String(ls.find(e=>e.name==='big.py')?.size));

  ok('exists() true for present file', await mp.exists('main.py'));
  ok('exists() false for absent file', (await mp.exists('nope.py')) === false);

  // ENOENT is what /code-robot keys the starter-template offer off.
  let threw = null;
  try { await mp.readTextFile('missing.py'); } catch (e) { threw = e.message; }
  ok('missing file raises with ENOENT', threw !== null && /ENOENT/.test(threw), String(threw));

  await mp.close();
  ok('close() releases the port', mp.port === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
