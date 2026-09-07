# Move all MiniCore interaction into the website

## Context

Today a student needs a git clone, a Python toolchain, and a terminal to change robot
behavior: edit `firmware/esp32-robot/main.py`, run `./scripts/flash-robot.sh`, and push
through GitHub. Admins need the same plus ESP-IDF v5.3.2 to reflash a dongle. That
toolchain is the barrier — not the robot code.

The driver station at <https://minibots.team2367.org> already proves the browser can own
this: it drives the dongle over **WebHID** and requires Chrome/Edge over HTTPS. **Web
Serial** carries identical constraints (secure context, one user gesture, persistent
per-origin grants, `setSignals()` for DTR/RTS), so reaching the robot over serial spends
no new compatibility budget.

Outcome: one site with four pages. Students edit and deploy `main.py` from the browser;
admins flash dongle firmware and convert fresh ESP32s to MicroPython. No clone, no
terminal, no GitHub account. The flash scripts stay as the CLI path and the source of
truth for pinned versions.

## Feasibility — verified, not assumed

| Capability | Verdict | Evidence |
|---|---|---|
| Read/write robot files from browser | Yes | mpremote's `fs_readfile` (`transport.py:133`) is just `exec("f=open('X','rb')\nr=f.read")` + repeated `eval("r(256)")`. Raw-paste REPL is a documented byte protocol. Read is nearly free once write exists. |
| Flash MicroPython to fresh ESP32 | Yes | `esptool-js@0.6.1` has real `esp32.ts`/`esp32s3.ts` targets, `eraseFlash`, `writeFlash`, `ClassicReset`. Classic ESP32 has a UART bridge → no button press. |
| Flash dongle firmware | Yes, with the existing button press | Dongle firmware is HID-only (`CFG_TUD_HID 1`, no CDC, `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=n`) so no serial port exists while it runs. Manual BOOT/RESET exposes the ROM bootloader — **exactly today's documented flow**, so no regression. |
| Session-only code storage | Yes | `sessionStorage` is per-tab, survives reload and crash-restore, cleared on tab close. |
| `cleanUrls` for `/control` etc. | Yes | Confirmed a valid boolean key in the live firebase-tools JSON schema. |

## Decisions locked

1. **Routing** — flat `.html` + `cleanUrls: true`. `/` = hub, `/control`, `/flash-dongle`, `/code-robot`.
2. **No durable code storage** — `sessionStorage` only; the robot is the source of truth.
   Plus a `beforeunload` guard and a **Download main.py** button, because the robot
   becomes the only copy.
3. **REPL** — read + write + read-only `print()` streaming. No input prompt.
4. **Upload** — all 5 files every push, library served same-origin, so the library always
   matches the deployed site.
5. **Editor** — CodeMirror **5.65.19** from cdnjs. Verified paths are at the package root,
   *not* under `lib/`: `codemirror.min.js` (167 KB), `codemirror.min.css` (6 KB),
   `mode/python/python.min.js` (6.4 KB), `addon/edit/matchbrackets.min.js` (3 KB). UMD,
   defines a `CodeMirror` global → **no build step**. (CM6 is ESM-only and would have
   forced bundling; `6.65.7` on cdnjs is a broken entry whose `lib/` 404s.)
6. **Dongle binaries** — fetched cross-origin from `raw.githubusercontent.com`
   (verified `access-control-allow-origin: *`).
7. **Full robot reflash** — fresh ESP32 → MicroPython, including writing `boot.py`.

### Accepted trade-offs

Both were reconfirmed deliberately; recorded so they are not mistaken for oversights.

- **CDN editor breaks offline.** `style.css:33` ships no webfont because *"a competition
  venue is where a font CDN fetch fails."* A cdnjs-loaded editor fails in that same
  scenario. Control, flash-dongle and the hub keep working; only `/code-robot` goes down.
- **No offline dongle flashing.** Binaries come from GitHub at flash time, so flashing
  needs working internet at the venue.

## Must-resolve before build

**The MicroPython image is not in git.** `.gitignore:24` ignores
`firmware/esp32-robot/micropython/*.bin`, and micropython.org sends **no CORS header**
(verified: `HTTP 206`, no `access-control-allow-origin`), so the browser cannot fetch it
from upstream. The full-reflash feature therefore has no image source today.

Resolution: commit the 1.76 MB `ESP32_GENERIC-20260406-v1.28.0.bin` to a new
`firmware/prebuilt/`. Verified **not** covered by `.gitignore` (only the
`esp32-robot/micropython/` path is), so no `.gitignore` change is needed. Keep the
existing SHA256 (`cd7820d0…`) as an integrity check in the manifest, mirroring
`flash-robot.sh:151`.

## Findings that shape the design

- **`app.js` has zero exports** and lines 966–1159 are bare top-level statements
  (`$("btnConnect").addEventListener(...)`, two `setInterval`s, a `buildSlots()` bootstrap
  that does `$("slots").innerHTML=""` unguarded). Any page importing it throws. But `$`
  is a lazy per-call `getElementById`, so *function definitions* extract cleanly — only
  the invocation statements are eager. `constants.js ← protocol.js` is clean and reusable
  unmodified.
- **`boot.py` is never uploaded** by any script (`flash-robot.sh:193` sends 5 files, not
  6) — it is assumed already present. Yet `boot.py` is what creates the 1500 ms
  interruptible window every upload depends on. A fresh-ESP32 path must write it.
- **`calib.json` silently overrides `main.py`.** The robot writes `{"nl","nr"}` when the
  driver station applies a neutral, and `begin()` reads it back over the config values
  (`minibot.py:305`). The robot README already calls this a confusion point. Reading it
  alongside `main.py` turns it into visible information.
- **CSS has no precedent** for links, nav, tabs, `<textarea>`, or code blocks — all four
  new page types need net-new components. Also 9 one-off hardcoded hexes for
  state-tinted text (`#d6f0fa`, `#f4dcc8`, `#ffd9d6`, …) with no tokens, and no formal
  spacing scale.

## Design system: how the skills are used

You asked to pass the frontend through several design skills to hold one aesthetic. Used
as a *stack* they would break it, so they are used in **roles**. `web/css/style.css` is a
bespoke, argued system: four OKLCH-validated status colors, no state signalled by color
alone (green/red separate by only ΔE 2.6 under tritanopia), monospace-only with **no
webfont** because *"a competition venue is where a font CDN fetch fails"*, dense
instrument-panel layout, borders used as bezels.

| Skill | Status | Role |
|---|---|---|
| **impeccable** v4.0.4 | installed, enabled | Primary. `document` → `DESIGN.md`; Operate mode for the three tool pages |
| **frontend-design** | installed, enabled | Aesthetic direction for the hub — the only Read/Persuade surface |
| **taste** | **installed but not loading** | Final lint pass, cherry-picked (see below) |
| **awesome-design** = `bergside/awesome-design-skills` | not installed | Reference only — 67 *replacement* aesthetics, installed via `npx typeui.sh`, not a CC plugin (no `marketplace.json`) |
| **theme-factory**, **web-artifacts-builder** | installed, **disabled** in `settings.json` `skillOverrides` | Skip. Both retheme or target claude.ai artifacts, not static Firebase pages |

**`taste` is invisible to the session because its files are one level too deep** —
`~/.claude/skills/taste/default/SKILL.md` instead of `~/.claude/skills/taste-default/SKILL.md`.
Every other skill in that folder has a top-level `SKILL.md` and loads. Fix: flatten the 7
sub-skills into sibling directories, then restart. Optional — the plan does not depend on it.

**Rules deliberately waived.** `taste-default` mandates *"Maximum 1 accent color +
neutrals"*, *"Default to generous spacing"*, and *"Borders are a last resort"*. All three
contradict the documented accessibility and density decisions above. Waived on that
evidence; its spacing-scale, one-primary-action, and type-hierarchy rules are adopted.

Two impeccable "refuse" rules bite on this brief and are honored:
- *"Same-size cards of icon + heading + text as the page structure. Cards are the lazy
  container."* → the hub is **not** three equal cards. Control is dominant (it is the
  competition path); flash-dongle and code-robot are subordinate.
- *"A kicker or eyebrow above a heading — a ban, not a default."* → the existing panel
  uses the uppercase-eyebrow label in 12 places and it is load-bearing instrument
  vocabulary, so it **stays** on tool pages under impeccable's own higher rule (*"the
  brief wins"*). No new eyebrows on the hub.

### Token work this forces

Before new pages can be styled consistently, three gaps get closed in `style.css`:

1. **State-tinted text tokens.** Nine one-off hexes (`#d6f0fa` btn--primary, `#f4dcc8`
   notice, `#ffd9d6` fault, `#eafff2`/`#ffeceb` arm switch, …) have no tokens, while every
   tinted *background* correctly uses `color-mix()`. Add `--go-text`, `--stop-text`,
   `--warn-text`, `--info-text` and refactor those nine, so new alert/status components
   don't invent a tenth.
2. **A spacing scale.** No formal scale exists — ~30 ad-hoc rem values, one token
   (`--gut`). Adopt the existing cluster as a named scale (`--sp-1`…`--sp-6`) for *new*
   code; grandfather existing declarations rather than churn 848 lines.
3. **Net-new components**, authored in the existing vocabulary (mono, `--s-rise` +
   `--line-bright` chrome, `var(--r)` radius): **links** (zero precedent — no `<a>` is
   styled at all), **nav**, **`<textarea>`**/editor shell, **code block**, and **tabs**
   for code-robot's three modes. Extract `.calib__field input` (`style.css:561`) into a
   reusable field pattern; promote the already-global bare `select` rule (507) to core.

### CSS file split

`style.css` (848 lines) → `core.css` (tokens, resets, `.bezel`, `.rail`, `.tele`, `.btn`,
`.notice`, `.fault`, `.dot`, `.num`, `kbd`, `select`, `.card--util`, `.log`,
reduced-motion) + `control.css` (`.arm`, `.slot`, `.slots`, `.sticks`, `.limit`, `.calib`,
`.deck`, `.rlist`, `.glist`) + one small stylesheet per new page. Two rules need splitting
by selector, not by file: the `@media (max-width:40rem)` block (791–818) touches both
chrome and control content, and the `forced-colors` block (836–848) names `.slot`/`.glist
li` inline.

Every page's `<body>` keeps `data-armed` and `data-link` attributes — `.bezel` and
`#dongleDot` key off them, and a missing attribute is a silent no-op that pins the visual
in the wrong state.

## Page designs

### `/` — hub (Read mode)

Project explanation and routing. Not three equal cards (see the refuse rule above):
Control is visually dominant as the competition path; flash-dongle and code-robot are
subordinate entries. Carries the what-this-is explanation, the Chrome/Edge + HTTPS
requirement, and the physical setup each tool needs. `<body>` still declares
`data-armed="false" data-link="down"`.

### `/control` — driver station (Operate)

The existing page, moved verbatim. Same DOM ids, same behavior, plus nav back to the hub.
Zero functional change — this page is used at competitions and must not regress.

### `/flash-dongle` — dongle firmware (Operate)

Fetches the three images from raw.githubusercontent, then `esptool-js` writes
`0x0` bootloader · `0x8000` partition-table · `0x10000` app (offsets read from
`build/flash_args`). Leads with the BOOT/RESET instruction, because the HID-only firmware
means no serial port exists until the ROM bootloader is exposed — a state the page must
explain rather than fail into. Reuses the `.log` panel for progress.

### `/code-robot` — Python editor (Operate)

Three explicitly separated modes, because two of them are destructive:

1. **Pull from robot** — read `main.py` + `calib.json` over raw REPL into the editor.
   `ENOENT` on `main.py` → offer the starter template instead of a blank editor.
2. **Upload + run** — write all 5 files, soft-reset, stream `print()` output read-only.
3. **Full reflash** — `erase_flash` + `write_flash 0x1000 <micropython.bin>`, then write
   all **6** files (the 5 plus `boot.py`). This is the fresh-ESP32 path and the only way
   `boot.py` ever reaches a board.

Mode confusion is the main hazard: **reflash erases the entire filesystem**, including
`calib.json` and whatever code is on the board. Mitigations — reflash is visually
separated from the two everyday actions, is gated behind a typed confirmation, and offers
to pull `main.py` first so the student's existing code isn't destroyed unread.

Two things this page can retire from the CLI:

- **`calib.json` visibility.** Show the saved neutrals next to the config line and say
  plainly that they override `main.py` (`minibot.py:305`). Verified bounds for form
  validation: `robot_id` ≤ 16 chars (`minibot.py:42`), constructor neutral clamp
  **500–2500 µs** (`_PWM_MIN_US`/`_PWM_MAX_US`, `minibot.py:104`), over-the-air trim clamp
  1000–2000 (`minibot.py:122`), channel default 6. Note `MinibotConfig` itself validates
  **nothing** — it is a pure data holder, and its docstring's "1000-2000" is descriptive
  only, so the form is the first real gate.
- **`clear_calibration()`** — currently REPL-only, with the README sending students to
  `flash-robot --repl` for it. Expose it as a button; it is a single `exec` on a channel
  the page already has.

**No pyright.** `.github/workflows/pyright.yml` type-checks `main.py` on PRs to `main`;
students who never open a PR lose that gate. Raw-paste mode compiles as it receives, so
syntax errors surface on upload — but attribute and type errors, which is what pyright is
for, do not. This is a real regression from the git flow and is called out, not solved.

## File layout

`constants.js` (45 exports) and `protocol.js` (13 exports, all named, no cycles) are reused
**unmodified** — verified clean. The work is extracting shared pieces out of `app.js`
without changing `/control`'s behavior.

```
web/
  index.html          hub                    core.css + hub.css
  control.html        moved verbatim         core.css + control.css   -> js/control.js
  flash-dongle.html                          core.css + flash.css     -> js/flash-dongle.js
  code-robot.html                            core.css + editor.css    -> js/code-robot.js

  js/
    constants.js      UNCHANGED (45 exports)
    protocol.js       UNCHANGED (13 exports)
    dom.js            NEW  $, log(), clearLog(), LOG_MAX  (lifted from app.js:109-130)
    store.js          NEW  sessionStorage get/set with the try/catch + validate + default
                           pattern from loadSpeedLimit() (app.js:70-84)
    hid.js            NEW  isDongle(), sendReport(), openDongle() — the DOM-free half
                           of app.js's transport, re-authored (attach/connect/disconnect
                           currently mix transport with control DOM and cannot be lifted)
    serial.js         NEW  MicroPython raw-paste REPL over Web Serial
    esptool.js        NEW  thin wrapper over the jsdelivr ESM bundle + port-ownership guard
    control.js        = today's app.js minus what moved to dom.js/hid.js
  templates/
    main.py           starter template for a board with no main.py
  lib/                the 5 robot .py files, served same-origin for upload
```

**Library drift is the risk** in `web/lib/`: two copies of `minibot.py` that must not
diverge. Mitigation — a CI check that diffs `web/lib/*.py` against
`firmware/esp32-robot/*.py` and fails the build on mismatch. Not a symlink (Firebase
Hosting does not follow them) and not a build step (the repo has no build tooling and the
CDN choice was made partly to keep it that way).

## `serial.js` — the raw-REPL contract

Transcribed from mpremote's own source (`transport_serial.py:162`, `transport.py:80/133`)
rather than reconstructed, so the browser reproduces the sequence that is known to work:

```
enter:   write "\r\x03"           ctrl-C, interrupt the running program (note leading \r)
         drain input
         write "\r\x01"           ctrl-A, enter raw REPL
         await "raw REPL; CTRL-B to exit\r\n>"
         write "\x04"             soft reset
         await "soft reboot\r\n"  (separate await lets boot.py's output through)
         await "raw REPL; CTRL-B to exit\r\n"
exit:    write "\r\x02"
follow:  read to \x04 (stdout), then to \x04 (stderr)
```

Raw-paste handshake: write `\x05A\x01`, read 2 bytes — `R\x01` supported, `R\x00`
understood-but-unsupported, `ra` no such command (then discard
`"w REPL; CTRL-B to exit\r\n>"`); fall back to plain raw REPL on the latter two. Then read a
16-bit LE window size and honor flow control on `\x01` / `\x04`.

File ops are just `exec`/`eval` on top of that — `readFile` is
`exec("f=open(p,'rb')\nr=f.read")` then repeated `eval("r(256)")`; `listDir` is
`exec("import os\nfor f in os.ilistdir():\n print(repr(f),end=',')")` parsed host-side.

API: `connect()`, `disconnect()`, `enterRaw()`, `exec()`, `eval()`, `readFile()`,
`writeFile()`, `listDir()`, `softReset()`, `streamOutput()`. Retry policy mirrors
`flash-robot.sh:190` — **5 attempts, 1 s apart**, and on final failure surface the same
remediation the script prints (retry, hold BOOT, or reflash MicroPython).

Two mechanics to get right: a single long-lived reader with a `TextDecoder` stream, since
alternating `getReader()`/`releaseLock()` between calls drops bytes mid-sentinel; and
`streamOutput()` must yield the reader back before the next `exec`, or the two deadlock.

## Port ownership: the one hard implementation trap

`/code-robot` runs **two** serial consumers on one page — my raw-REPL module and
esptool-js — and they cannot coexist on a port. Read directly from the pinned bundle:
`Transport.connect()` calls `device.open({baudRate})` itself, and `disconnect()` cancels
its reader, calls `waitForUnlock(400)`, then `device.close()`. Its read loop holds
`device.readable.getReader()` for its whole lifetime.

So the rule is: **exactly one owner at a time.** Before reflash, `serial.js` must cancel
its reader, `releaseLock()`, and `close()` the port; only then may esptool-js take it.
After reflash, esptool-js must fully `disconnect()` before `serial.js` reopens to write the
6 files. A single shared `port` reference with an explicit owner state — and a guard that
refuses a mode switch while the other owner is live — prevents the `readable.locked`
deadlock, which otherwise presents as a silent hang rather than an error.

Also verified: esptool-js 0.6.1 `bundle.js` (214 KB) is **ESM** (`export{… ESPLoader,
Transport, ClassicReset, HardReset, UsbJtagSerialReset …}`), served from jsdelivr with
`access-control-allow-origin: *`, so it loads via `import()` with no build step. Its
`ClassicReset` sequence (DTR/RTS toggling) is what enters the bootloader on the robot's
UART-bridge board without a button press.

**CDN assets are pinned with SRI.** No CSP exists in the project, so cdnjs/jsdelivr load
unblocked — which also means a compromised CDN could inject code into a page that talks to
hardware. Use `integrity` on all four CodeMirror assets (hashes available from the cdnjs
API, e.g. `codemirror.min.js` → `sha512-tXHFLFVaasTvIEFYN8K6UlGvb6Sh1eal…`).

## Verification

Hardware was not attached during planning (`ls /dev/cu.*` found nothing), so every
device-path step below is for you to run. `firebase` 15.8.0 and node 24.6.0 are on PATH.

**Local serving — use the emulator, not `http.server`.** I confirmed
`python3 -m http.server` returns **404 for `/control`** because it does not emulate
`cleanUrls`; the extensionless routes only resolve through Firebase. So the README's
`python3 -m http.server 8080` recipe stops being sufficient once pages are split:

```bash
firebase emulators:start --only hosting   # serves cleanUrls correctly on localhost
```

WebHID/Web Serial both accept `http://localhost`, so no local TLS is needed.

**Regression gate — `/control` must be unchanged.** Before touching anything else:
diff the moved page against today's, connect a dongle, confirm auto-reconnect, pair a
slot, arm/disarm, drag the speed limit, apply a neutral, and check `packets out` still
climbs. Any behavior change here is a bug, not a redesign.

**Per-page checks:**

| Page | Verify |
|---|---|
| `/` | All three links resolve; renders with no console errors; explains the Chrome/Edge requirement |
| `/flash-dongle` | Fetch the 3 images (watch the network tab for the cross-origin GETs); BOOT/RESET, flash, then confirm the dongle comes back as `PID_4002` with no COM port and `/control` reconnects to it |
| `/code-robot` pull | Plug a robot **already running** `main.py` → confirm the Ctrl-C race wins within the 5-try loop; then a board sitting at the REPL → confirm instant read; then a board with no `main.py` → confirm ENOENT offers the template |
| `/code-robot` upload | Push all 5, confirm reset + `print()` output streams; verify `bot.get_game_status()` still responds from `/control` afterward |
| `/code-robot` reflash | On a **spare** ESP32 first: erase + MicroPython + all 6 files, then confirm it boots, prints `[boot] Starting in 1500 ms`, and appears in `/control`'s scan |
| `calib.json` | Apply a neutral from `/control`, reload `/code-robot`, confirm the saved value is shown as overriding `main.py`; then use the clear-calibration button and confirm `main.py`'s value takes effect after a reset |

**Session-storage behavior:** type in the editor, reload → buffer survives. Close the tab,
reopen → buffer is gone (this is the intended design). Confirm the `beforeunload` guard
fires on close with unsaved edits, and that **Download main.py** produces a valid file.

**Offline check (documents the accepted trade):** disable networking, then load all four
pages. Expected: hub, `/control` and `/flash-dongle`'s shell still render; `/code-robot`'s
editor fails to initialize and `/flash-dongle` cannot fetch binaries. Confirm each fails
with a legible message rather than a blank page.

**CI:** `.github/workflows/pyright.yml` and `flash-scripts.yml` should still pass — the
flash scripts are untouched. Note that `pyright` never sees browser-authored code.

## Other changes

**`firebase.json`** — add `"cleanUrls": true`. The existing `no-cache` headers block
already globs `/**/*.@(html|css|js)`, which covers the new pages. Add `web/lib/*.py` and
`web/templates/*.py` to that no-cache treatment: a cached stale `minibot.py` would be
uploaded to robots. The `index.html` host-redirect script (which bounces `*.web.app` to the
custom domain) must be copied into each new page, since it runs before render and there is
no backend to do it centrally.

**Docs** — `README.md` gains a browser-workflow section alongside the CLI one; the local-dev
recipe changes from `python3 -m http.server` to `firebase emulators:start`;
`firmware/esp32-robot/README.md` notes that `main.py` can now be edited in the browser and
that `clear_calibration()` has a button.

**Scripts stay.** `flash-robot.*` / `flash-dongle.*` remain the CLI path, the offline
fallback, and the source of truth for pinned versions (ESP-IDF v5.3.2, MicroPython
v1.28.0). Nothing about them changes.

## Sequencing

1. Commit `firmware/prebuilt/ESP32_GENERIC-20260406-v1.28.0.bin` (unblocks reflash).
2. Token + CSS split; `dom.js` / `store.js` / `hid.js` extraction; move `/control`,
   `cleanUrls`. **Verify `/control` is unchanged before continuing.**
3. Hub page.
4. `serial.js` + `/code-robot` pull & upload (the highest-value half).
5. `esptool.js` + `/flash-dongle`, then `/code-robot` full reflash (shares the wrapper).
6. Docs, CI library-drift check, `taste` flatten if wanted.
