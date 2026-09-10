# Browser-side tests

No test framework and no dependencies — plain `node` scripts, because the repo has
no build tooling and the browser code is dependency-free ES modules for the same
reason. Run them from this directory:

```bash
node serial.test.mjs        # raw-REPL protocol against a simulated board
node codec-literals.mjs     # emits bytesLiteral() output as JSON (see below)
node codec-parse.mjs        # parseBytesRepr() against real Python repr() output
node drivers.test.mjs       # detectOS() against injected navigator shapes
```

## `serial.test.mjs`

`fake-board.mjs` is a MicroPython board that speaks the real raw-REPL byte
protocol: the Ctrl-C interrupt, the `\x05A\x01` raw-paste negotiation with a
16-bit window and `\x01` flow control, the two-`\x04` output framing, and a small
interpreter for exactly the commands `serial.js` sends. It emits boot.py's
startup line in the gap between `soft reboot` and the raw banner — the reason
mpremote awaits those two separately.

Both negotiation outcomes are exercised: `R\x01` (raw-paste) and `R\x00`
(fall back to plain raw REPL, 256 bytes at a time). The window size is set to 64
so a multi-KB file crosses many flow-control windows rather than fitting in one.

### Handshake cancellation

`silentPort()` is the other half: a port that opens and then says nothing, which
`FakeBoard` cannot be because it always answers. That is a board with no
MicroPython on it — the board /code-robot's Erase button exists for — and against
it every one of the five attempts fails, so the loop is ~30 s of dead time. Erase
aborts it instead of waiting, and these assertions pin that it actually stops.

A click can land in any of the handshake's **three** waits, and they are not one
mechanism: `enterRaw`'s 120 ms settle and the 1 s inter-attempt delay are
`sleepOr`, while the long one is a poll inside `#readUntil`. All three are covered
separately, and the reason is a real escape: an earlier version aborted only at
50 ms, landed in the settle sleep, and still passed with `#readUntil`'s abort check
deleted outright. Each also asserts the cancelled attempt is **not** reported as
`REPL attempt N of 5 failed` — that line blames the board for the user's decision.

Two things are deliberately absent. The full five-attempt exhaustion is ~30 s of
wall clock and would turn an instant suite into one nobody runs. And the file has
one slow assertion by necessity: landing inside the inter-attempt delay means
waiting out one 5 s read timeout first, so it prints a line saying so rather than
looking hung.

## `drivers.test.mjs`

`detectOS()` takes its navigator as a parameter, so this hands it plain objects
and needs no DOM — the same injection style as the fake port above. Covers
`userAgentData` and the deprecated `navigator.platform` fallback, both cases and
precedence, and the shapes that must degrade to `"other"` rather than guessing.

It already earned its keep: `"darwin"` contains `"win"`, so an earlier version
checking Windows first classified every Darwin platform string as Windows. On this
site that specific bug would have offered a Mac user a driver download that
conflicts with Apple's own and can stop a working Mac from seeing the board, so
the mac-before-windows order in `detectOS` is deliberate and this test pins it.

`mountDriverHelp()` is not covered: it is DOM construction, and testing it would
need jsdom, which the no-dependency rule above rules out.

## Byte codecs

These two matter more than they look. `bytesLiteral()` builds the `w(b'…')` that
writes a student's file, and `parseBytesRepr()` reads what `repr()` returns —
so a single escaping mistake silently corrupts robot code.

They are checked against **real Python**, not against each other:

```bash
node codec-literals.mjs > /tmp/lits.json
python3 -c "
import json, ast
d = json.load(open('/tmp/lits.json'))
bad = [i for i, x in enumerate(d)
       if ast.literal_eval(x['lit']) != bytes.fromhex(x['hex'])]
print('mismatches:', bad or 'none')
json.dump({'reprs': [repr(bytes.fromhex(x['hex'])) for x in d],
           'hex': [x['hex'] for x in d]}, open('/tmp/reprs.json', 'w'))
"
node codec-parse.mjs
```

Coverage is all 256 single byte values, all 256 at once, and strings carrying
quotes, backslashes, NUL, CR/LF/TAB and multi-byte UTF-8. Last run: 262/262 exact
in both directions.
