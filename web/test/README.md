# Browser-side tests

No test framework and no dependencies — plain `node` scripts, because the repo has
no build tooling and the browser code is dependency-free ES modules for the same
reason. Run them from this directory:

```bash
node serial.test.mjs        # raw-REPL protocol against a simulated board
node codec-literals.mjs     # emits bytesLiteral() output as JSON (see below)
node codec-parse.mjs        # parseBytesRepr() against real Python repr() output
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
