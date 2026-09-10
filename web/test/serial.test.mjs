import { FakeBoard } from './fake-board.mjs';
const { MicroPythonSerial, CancelledError, RETRY_ATTEMPTS } =
  await import('../js/serial.js');

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

/**
 * A port that opens and then says nothing — a board with no MicroPython on it, or
 * one whose main.py cannot be interrupted. FakeBoard always answers, so it cannot
 * produce this: the retry loop never runs against it.
 */
function silentPort() {
  let cancelled = false;
  return {
    async open() {},
    async close() {},
    readable: {
      getReader() {
        return {
          async read() {
            while (!cancelled) {
              await new Promise(r => setTimeout(r, 5));
            }
            return { done: true };
          },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
    writable: {
      getWriter() {
        return {
          async write() {}, async close() {}, releaseLock() {},
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

/*
 * Cancelling the handshake.
 *
 * /code-robot's Erase button is for a board with no MicroPython — where all
 * RETRY_ATTEMPTS are certain to fail, and waiting them out is ~30 s of dead time.
 * These pin that the wait is preemptable, and how fast.
 *
 * The full exhaustion path is deliberately NOT tested: it is that same ~30 s of
 * wall clock, and it would turn an instant suite into one nobody runs.
 */
console.log('\n=== handshake cancellation ===');
{
  // One attempt is a 5 s read timeout; the whole loop is ~30 s. A cancellation
  // that took either would be indistinguishable from not being wired up, so the
  // budget has to sit well under one attempt.
  const BUDGET = 2000;

  /**
   * A click can land in any of the handshake's three waits, and they are three
   * different mechanisms — enterRaw's 120 ms settle and the inter-attempt delay
   * are sleepOr, the long one is a poll inside #readUntil. Covering only one
   * leaves the others free to regress: an earlier version of this file aborted at
   * 50 ms, landed in the settle sleep, and passed with #readUntil's abort check
   * deleted outright.
   *
   * @param {string} label
   * @param {number} abortAtMs When to abort, relative to the handshake starting
   */
  async function abortsIn(label, abortAtMs) {
    const mp = new MicroPythonSerial();
    await mp.connect(silentPort());
    const abort = new AbortController();
    const attempts = [];
    const t0 = Date.now();
    setTimeout(() => abort.abort(), abortAtMs);
    let caught = null;
    try {
      await mp.enterRawWithRetry(m => attempts.push(m), { signal: abort.signal });
    } catch (e) { caught = e; }
    const ms = Date.now() - t0;

    ok(`abort in ${label} rejects with CancelledError`,
       caught instanceof CancelledError, String(caught));
    ok(`abort in ${label} returns fast (${ms} ms < ${BUDGET})`, ms < BUDGET);
    // The user cancelled; the board did not fail. Saying "attempt 1 of 5 failed"
    // would blame the board for a decision the user made.
    ok(`abort in ${label} is not reported as a failed attempt`,
       attempts.length === 0, JSON.stringify(attempts));
    ok(`inRaw stays false after a cancel in ${label}`, mp.inRaw === false);
    await mp.close();
    ok(`close() after a cancel in ${label} releases the port`, mp.port === null);
  }

  // (a) The 120 ms settle after Ctrl-C — sleepOr inside enterRaw.
  await abortsIn('the settle sleep', 50);

  // (a2) The read wait — 120 ms in, blocked in #readUntil(RAW_PROMPT, 5000) with
  // nothing coming. The long one, and the one a real click almost always hits.
  await abortsIn('the read wait', 400);

  // (b) Abort during the 1 s gap BETWEEN attempts. Distinct from (a): this is the
  // one that catches sleepOr having been left as a plain sleep(), where the abort
  // would sit unnoticed for the rest of the delay.
  {
    const mp = new MicroPythonSerial();
    await mp.connect(silentPort());
    const abort = new AbortController();
    const attempts = [];
    // Land inside the delay by waiting for attempt 1 to be REPORTED, rather than
    // guessing at a wall-clock time. Costs one 5 s read timeout — the only slow
    // assertion in this file, and the reason it says so before it starts.
    console.log('  (waiting out one 5 s read timeout to land inside the delay…)');
    let armedResolve;
    const armed = new Promise(resolve => { armedResolve = resolve; });
    const inflight = mp.enterRawWithRetry(
      m => { attempts.push(m); if (attempts.length === 1) armedResolve(); },
      { signal: abort.signal },
    );
    await armed;
    const t0 = Date.now();
    abort.abort();
    let caught = null;
    try { await inflight; } catch (e) { caught = e; }
    const ms = Date.now() - t0;

    ok('abort mid-delay rejects with CancelledError',
       caught instanceof CancelledError, String(caught));
    ok(`abort mid-delay is not swallowed by the delay (${ms} ms)`, ms < 900,
       `RETRY_DELAY_MS is 1000 — ${ms} ms means it ran the sleep out`);
    ok('only the genuinely failed attempt was reported',
       attempts.length === 1 && attempts[0].includes(`1 of ${RETRY_ATTEMPTS}`),
       JSON.stringify(attempts));
    await mp.close();
  }

  // (c) A signal that is never aborted must change nothing. Cheap, and it is what
  // rules out the threading itself having broken the normal path.
  {
    const board = new FakeBoard({ files: {} });
    const mp = new MicroPythonSerial();
    await mp.connect(fakePort(board));
    await mp.enterRawWithRetry(() => {}, { signal: new AbortController().signal });
    ok('un-aborted signal still reaches the REPL', mp.inRaw === true);
    await mp.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
