/**
 * /code-robot — read, edit and push robot code from the browser.
 *
 * Three modes, one of which erases the board. The hazard here is mode confusion,
 * so reflash is visually separated, gated behind a typed confirmation, and offers
 * to pull first.
 *
 * The editor buffer lives in sessionStorage only: the robot is the source of
 * truth for code, and a draft that outlived the tab would compete with it. The
 * cost is that after an upload the robot holds the only copy, which is why there
 * is a beforeunload guard and a Download button.
 */

import { $, log, clearLog } from "./dom.js";
import { session } from "./store.js";
import { MicroPythonSerial, CancelledError } from "./serial.js";
import { mountDriverHelp } from "./drivers.js";
import {
  PortOwner,
  flash,
  fetchImage,
  signalsAreAtomic,
  ROBOT_MICROPYTHON_OFFSET,
} from "./esptool.js";

/** The library modules flash-robot.sh:193 uploads (it globs *.py minus boot.py).
 *  Every module minibot.py imports has to be here: the import is top-level, so a
 *  missing one is an ImportError at boot, not a degraded robot. */
const LIB_FILES = [
  "minibot.py",
  "comm_module.py",
  "minibot_config.py",
  "display.py",
  "ssd1306.py",
  "button.py",
  "neopixel_ring.py",
];
/** boot.py is the last, written only on a full reflash — no script ever sends
 *  it, yet it is what creates the 1500 ms window every upload depends on. */
const BOOT_FILE = "boot.py";

const CALIB_PATH = "calib.json";
const BUF_KEY = "minicore.editorBuffer";
const MICROPYTHON_URL =
  "https://raw.githubusercontent.com/Saint-Francis-Robotics-Team2367/minibots-2026/" +
  "main/firmware/prebuilt/ESP32_GENERIC-20260406-v1.28.0.bin";
/** Same hash flash-robot.sh:151 verifies. */
const MICROPYTHON_SHA256 =
  "cd7820d02c35d34dd403b44263129c6a511b350aea8446c229890753fe240784";

const mp = new MicroPythonSerial();
const owner = new PortOwner();

/** @type {any} CodeMirror instance, or null when the CDN did not load. */
let cm = null;
/** Set once the editor content differs from what the robot has. */
let dirty = false;
/** Stop function from streamOutput(), while output is being watched. */
let stopStream = null;
/**
 * Two states, not one, because the fresh-ESP32 case needs them apart.
 *
 * `portOpen` — we hold the serial port.
 * `atRepl`   — the board answered the raw-REPL handshake, so a REPL is reachable.
 *
 * A board with no MicroPython on it opens fine and never reaches a REPL. Gating
 * full reflash on `atRepl` would disable it on exactly the boards it exists for,
 * so pull/upload require `atRepl` while reflash requires only `portOpen`.
 *
 * Reachable is the operative word, and `atRepl` is deliberately NOT `mp.inRaw`:
 * every upload ends in a soft reset so main.py can run, which leaves raw mode
 * behind on a board that is still perfectly reachable. ensureRepl() closes that
 * gap by re-entering on demand, so the buttons can stay live across it.
 */
let portOpen = false;
let atRepl = false;
/**
 * The in-flight REPL handshake, or null.
 *
 * The handshake is 5 attempts spaced 1 s apart and every one of them fails on a
 * board with no MicroPython — ~30 s during which the only useful action is the
 * full reflash. So it is preemptable rather than blocking: Erase and Disconnect
 * both abort it (cancelHandshake) instead of waiting it out.
 *
 * Two fields, because aborting is not enough. enterRaw unwinds asynchronously, so
 * a preemptor that closed the port the instant it aborted would release the writer
 * out from under an abandoned #write and surface as an unhandled rejection.
 * `done` is what makes the unwind awaitable; it is stored pre-caught, so awaiting
 * it can never itself reject.
 *
 * @type {{ abort: AbortController, done: Promise<void> } | null}
 */
let handshake = null;
/**
 * True while a device operation owns the port and must NOT be preempted.
 *
 * Deliberately false during the handshake: that is the whole point above. It
 * covers pull, push and reflash, each of which either holds the port through
 * esptool or is mid-write to a filesystem.
 */
let busy = false;

/* ── Editor ─────────────────────────────────────────────────────────────── */

function initEditor() {
  const area = $("editor");
  // The textarea is the fallback, not a placeholder: with no CDN the buffer is
  // still editable and pull/upload still work, just without highlighting.
  if (typeof window.CodeMirror !== "function") {
    $("noEditor").hidden = false;
    log("Editor library unavailable — plain text editing still works", "warn");
    area.addEventListener("input", onEdit);
    return;
  }
  cm = window.CodeMirror.fromTextArea(area, {
    mode: "python",
    theme: "default",
    lineNumbers: true,
    indentUnit: 4,
    matchBrackets: true,
    lineWrapping: false,
    viewportMargin: 30,
  });
  cm.on("change", onEdit);
  // CodeMirror creates its own hidden textarea as the input proxy and leaves it
  // unlabelled, so a screen reader announces the editor as an anonymous text
  // field. The original textarea keeps its label but is display:none by then.
  const proxy = cm.getInputField();
  if (proxy && !proxy.getAttribute("aria-label")) {
    proxy.setAttribute("aria-label", "main.py source");
  }
}

/** @returns {string} */
function getCode() {
  return cm ? cm.getValue() : $("editor").value;
}

/** @param {string} text @param {boolean} [fromRobot] */
function setCode(text, fromRobot = false) {
  if (cm) {
    cm.setValue(text);
  } else {
    $("editor").value = text;
  }
  dirty = !fromRobot;
  saveBuffer();
  renderBuf();
}

function onEdit() {
  dirty = true;
  saveBuffer();
  renderBuf();
}

function saveBuffer() {
  const code = getCode();
  if (!code) {
    session.remove(BUF_KEY);
    return;
  }
  if (!session.set(BUF_KEY, code)) {
    // Worth saying out loud: without storage a reload loses the edit, and the
    // student would otherwise find that out by losing it.
    log("Could not save the draft — a reload will lose it", "warn");
  }
}

function restoreBuffer() {
  const saved = session.get(BUF_KEY, "", (raw) => raw);
  if (saved) {
    setCode(saved);
    dirty = true;
    log("Restored the draft from this tab's last load", "warn");
  }
}

function renderBuf() {
  const code = getCode();
  const n = code ? code.split("\n").length : 0;
  $("bufState").textContent = code ? `${n} line${n === 1 ? "" : "s"}` : "empty";
  $("btnDownload").disabled = !code;
}

/* ── Connection ─────────────────────────────────────────────────────────── */

function renderConn() {
  document.body.dataset.link = atRepl ? "up" : "down";
  // Three states for an open port, not two: "reaching" says the retries are still
  // running, which is what makes the enabled Erase button below make sense.
  $("portState").textContent = atRepl
    ? "Connected"
    : !portOpen
      ? "Not connected"
      : handshake
        ? "Port open — reaching the REPL…"
        : "Port open — no REPL";
  $("btnConnect").disabled = portOpen;
  // Live during the handshake (busy is false there) so it can cancel it. Disabled
  // during a real operation — including the reconnect inside fullReflash, which
  // calls through here mid-write.
  $("btnDisconnect").disabled = !portOpen || busy;
  // These three all execute Python on the board, so they need a live REPL — and
  // `busy` as well, because fullReflash reconnects to write its six files and so
  // reaches here with atRepl true mid-write. Without that term a click on Pull
  // there would interleave commands into an in-flight reflash.
  for (const id of ["btnPull", "btnPush", "btnClearCalib"]) {
    $(id).disabled = !atRepl || busy;
  }
  renderFlashGate();
}

/**
 * Open the port, then try for a REPL.
 *
 * A REPL failure is deliberately NOT a connect failure: a board with no
 * MicroPython, or one whose main.py cannot be interrupted, still needs the port
 * held so full reflash can take it. Only a port that will not open at all is
 * fatal here.
 *
 * The handshake does not set `busy`, so Erase and Disconnect stay live while it
 * runs — see the note on `handshake`.
 *
 * @param {SerialPort} port
 * @returns {Promise<boolean>} true when the REPL was reached
 */
async function connect(port) {
  owner.claim("repl");
  renderConn();
  try {
    await mp.connect(port);
    portOpen = true;
    renderConn();
    log("Serial port open — interrupting the robot to reach its REPL");
  } catch (err) {
    // Leave nothing half-owned: a port still held here cannot be reopened by
    // the flasher, and that failure would present as a hang.
    await mp.close().catch(() => {});
    owner.release("repl");
    portOpen = false;
    atRepl = false;
    renderConn();
    throw err;
  }
  const abort = new AbortController();
  const done = mp.enterRawWithRetry((m) => log(m, "warn"), { signal: abort.signal });
  // Pre-caught, so a preemptor awaiting it never has to handle the rejection that
  // is its own doing. The real promise is still what this function awaits.
  handshake = { abort, done: done.then(() => {}).catch(() => {}) };
  renderConn();
  try {
    await done;
    atRepl = true;
    log("At the robot's REPL", "go");
    return true;
  } catch (err) {
    atRepl = false;
    // A cancellation is not a diagnosis, so it says nothing here: the remediation
    // below would be actively misleading (nothing is wrong with the board — we
    // stopped asking), and whoever cancelled has the reason and logs it.
    if (err instanceof CancelledError) {
      return false;
    }
    log(`No REPL on this board: ${err.message}`, "warn");
    log(
      "If this board has never had MicroPython on it, use Reflash — that is what " +
        "it is for. Otherwise unplug and retry.",
      "warn",
    );
    return false;
  } finally {
    handshake = null;
    renderConn();
  }
}

/**
 * Abort an in-flight handshake and wait for it to let go of the port.
 *
 * Both halves matter. Without the abort the caller waits out the retries; without
 * the await it races an unwinding enterRaw for the writer. Safe to call when there
 * is no handshake, which is the common case.
 *
 * @returns {Promise<boolean>} true when there was one to cancel
 */
async function cancelHandshake() {
  const h = handshake;
  if (!h) {
    return false;
  }
  h.abort.abort();
  await h.done;
  return true;
}

async function disconnect() {
  stopWatching();
  // Before mp.close(): closing first releases the writer under an in-flight
  // #write, which surfaces as an unhandled rejection rather than an error.
  await cancelHandshake();
  await mp.close();
  owner.release("repl");
  portOpen = false;
  atRepl = false;
  setBusy(false);
  log("Disconnected");
}

/**
 * Re-enter the raw REPL if we are not in it, before anything executes Python.
 *
 * Every upload deliberately ends in softReset(), because that is how main.py
 * gets to run — and it leaves raw mode behind. `mp.inRaw` goes false while
 * `atRepl` stays true (see its note), so without this the next Upload, Pull or
 * Clear reaches the board's guard and fails with "Not in raw REPL", and stays
 * that way until a reconnect happens to redo the handshake. Reconnecting was the
 * only cure precisely because connect() held the only enterRaw call.
 *
 * With retry, not a bare enterRaw: by now the board is running the student's
 * code again, which is the same interruptible-window problem the initial
 * handshake has, and boot.py's window is 1500 ms.
 *
 * The stream is stopped first and unconditionally. streamOutput() drains the same
 * buffer the exec helpers read from, so it has to be off before a command either
 * way — and if it were still running it would eat the raw banner this waits for.
 * The visible consequence is that reading from the robot stops the robot; that is
 * inherent (you cannot read its files without interrupting it), so it is logged
 * rather than hidden.
 *
 * Not preemptable, unlike connect()'s handshake: callers hold `busy` through it,
 * which is what keeps a second click from interleaving commands. The worst case
 * is the same ~30 s of retries connect() can spend, and it narrates each attempt
 * rather than looking hung.
 *
 * @throws on a board that will not come back — with REMEDIATION, not a guard message
 */
async function ensureRepl() {
  stopWatching();
  if (mp.inRaw) {
    return;
  }
  log("Interrupting the robot to reach its REPL");
  try {
    await mp.enterRawWithRetry((m) => log(m, "warn"));
  } catch (err) {
    // The board stopped answering, so the buttons must stop claiming it will.
    atRepl = false;
    renderConn();
    throw err;
  }
  atRepl = true;
  log("At the robot's REPL", "go");
}

/* ── Pull ───────────────────────────────────────────────────────────────── */

async function pull() {
  if (dirty && !confirm("Replace the editor's contents with the robot's main.py?")) {
    return;
  }
  note("pullNote", "");
  setBusy(true);
  try {
    await ensureRepl();
    let code;
    try {
      code = await mp.readTextFile("main.py");
    } catch (err) {
      // ENOENT is the ordinary case for a board that has never been programmed,
      // so it gets an offer rather than an error.
      if (/ENOENT|No such file/i.test(String(err.message))) {
        note("pullNote", "This robot has no main.py yet — load the starter template.");
        log("No main.py on the robot", "warn");
        return;
      }
      throw err;
    }
    setCode(code, true);
    log(`Pulled main.py (${code.split("\n").length} lines)`, "go");
    await readCalibration();
  } catch (err) {
    note("pullNote", String(err.message), "err");
    log(`Pull failed: ${err.message}`, "err");
  } finally {
    setBusy(false);
  }
}

/**
 * Read calib.json and show it as what it is: values loaded OVER main.py's, per
 * minibot.py:305. A missing file is the normal case.
 */
async function readCalibration() {
  try {
    const raw = await mp.readTextFile(CALIB_PATH);
    const saved = JSON.parse(raw);
    $("calibL").textContent = String(saved.nl);
    $("calibR").textContent = String(saved.nr);
    $("calibBox").hidden = false;
    $("calibWarn").hidden = false;
    $("calibEmpty").hidden = true;
    log(`Saved calibration: left ${saved.nl} µs, right ${saved.nr} µs`, "warn");
  } catch (err) {
    $("calibBox").hidden = true;
    $("calibWarn").hidden = true;
    $("calibEmpty").hidden = false;
    $("calibEmpty").textContent =
      "No saved calibration — main.py's neutral values are the ones in effect.";
  }
}

/** clear_calibration() was REPL-only; the README sent students to --repl for it. */
async function clearCalibration() {
  if (!confirm("Delete the robot's saved calibration? main.py's values take over after a reset.")) {
    return;
  }
  setBusy(true);
  try {
    await ensureRepl();
    await mp.execOrThrow("import os\ntry:\n os.remove('calib.json')\nexcept OSError:\n pass");
    note("calibNote", "Cleared. Reset the robot for main.py's values to take effect.");
    log("Saved calibration cleared", "go");
    await readCalibration();
  } catch (err) {
    note("calibNote", String(err.message), "err");
    log(`Could not clear calibration: ${err.message}`, "err");
  } finally {
    setBusy(false);
  }
}

/* ── Upload ─────────────────────────────────────────────────────────────── */

/**
 * Write all five files every push, not just main.py.
 *
 * The library is served same-origin, so what lands on the robot always matches
 * the deployed site — there is no way for a student to run new code against an
 * old minibot.py.
 */
async function push() {
  note("pushNote", "");
  const code = getCode();
  if (!code.trim()) {
    note("pushNote", "The editor is empty.", "err");
    return;
  }
  const prog = $("pushProg");
  const fill = $("pushFill");
  prog.hidden = false;
  setBusy(true);
  try {
    // Before the first read: after any earlier upload the board is running, not
    // waiting at a prompt, and the boot.py check below is what used to trip over
    // that.
    await ensureRepl();

    // boot.py is checked first, and written when it is missing or is not ours.
    //
    // The scripts send five files and assume boot.py is already right
    // (flash-robot.sh:193). That assumption can be false on a board this page
    // itself flashed: MicroPython ships its own 139-byte boot.py, and a reflash
    // that installs the firmware but then fails to reconnect never reaches its
    // six-file step, leaving the stock one in place. Seen on real hardware. Since
    // boot.py is what creates the interruptible window every later upload needs,
    // an upload is the right moment to repair it.
    const bootBody = await fetchLib(BOOT_FILE);
    let needBoot = true;
    try {
      const onBoard = await mp.readFile(BOOT_FILE);
      needBoot = onBoard.length !== bootBody.length;
    } catch (err) {
      needBoot = true; // absent, unreadable — either way, write it
    }
    if (needBoot) {
      await mp.writeFile(BOOT_FILE, bootBody);
      log(`Wrote ${BOOT_FILE} — the board did not have ours`, "warn");
    }

    const files = [...LIB_FILES];
    const total = files.length + 1;
    let done = 0;
    for (const name of files) {
      const body = await fetchLib(name);
      await mp.writeFile(name, body);
      done++;
      fill.style.width = `${Math.round((done / total) * 100)}%`;
      log(`Wrote ${name} (${body.length} bytes)`);
    }
    await mp.writeFile("main.py", code);
    fill.style.width = "100%";
    log("Wrote main.py", "go");
    dirty = false;

    log("Restarting the robot");
    await mp.softReset();
    watchOutput();
    note("pushNote", "Uploaded. The robot is running your code.");
  } catch (err) {
    note("pushNote", String(err.message), "err");
    log(`Upload failed: ${err.message}`, "err");
  } finally {
    setBusy(false);
    prog.hidden = true;
    fill.style.width = "0";
  }
}

/**
 * Load the starter template into the editor.
 *
 * Shared by the Template button and by fullReflash's empty-editor case, so the
 * two cannot drift on which path is fetched or what gets logged.
 *
 * @throws on a failed fetch — both callers need to know, and reflash must not
 *   erase a board it has nothing to write to.
 */
async function loadTemplate() {
  const res = await fetch("templates/main.py");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  setCode(await res.text());
  log("Loaded the starter template");
}

/** @param {string} name @returns {Promise<Uint8Array>} */
async function fetchLib(name) {
  const res = await fetch(`lib/${name}`);
  if (!res.ok) {
    throw new Error(`Could not load lib/${name} (HTTP ${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/* ── Robot output ───────────────────────────────────────────────────────── */

function watchOutput() {
  $("outBox").hidden = false;
  $("outBody").textContent = "";
  stopStream = mp.streamOutput((chunk) => {
    const body = $("outBody");
    body.textContent += chunk;
    // Keep the tail visible: this is a running program, so the newest line is
    // the one being read.
    body.scrollTop = body.scrollHeight;
  });
}

/**
 * Stop the stream before anything else touches the port.
 *
 * streamOutput() drains the same buffer the exec helpers read from, so leaving
 * it running deadlocks the next command.
 */
function stopWatching() {
  if (stopStream) {
    stopStream();
    stopStream = null;
  }
}

/* ── Full reflash ───────────────────────────────────────────────────────── */

function renderFlashGate() {
  const typed = $("flashConfirm").value.trim().toUpperCase() === "ERASE";
  // portOpen, not atRepl: this is the tool for a board that has no REPL. And an
  // unfinished handshake is no reason to wait — clicking Erase cancels it (see
  // `handshake`), so the gate opens as soon as the port is ours. `!busy` still
  // holds the gate shut during an operation that cannot be preempted.
  $("btnFlash").disabled = !(portOpen && typed && !busy);
  // Say WHICH precondition is missing. A disabled button next to a correctly
  // typed confirmation reads as a broken page, and the one thing a student
  // cannot deduce is that the gate has two halves.
  if (!portOpen) {
    note("flashNote", "Connect the robot first — then type ERASE.");
  } else if (!typed) {
    note("flashNote", 'Type ERASE above to unlock the button.');
  } else if (!$("flashNote").dataset.kind) {
    // Naming the interruption is the point: the log is still printing REPL
    // attempts, so a bare "Ready" would look like it meant to wait for them.
    note(
      "flashNote",
      handshake
        ? "Ready. This stops the REPL attempts and erases the board."
        : "Ready. This erases everything on the board.",
    );
  }
}

/**
 * Erase, write MicroPython, then write all SIX files — the five the scripts send
 * plus boot.py. This is the only path that ever puts boot.py on a board, and
 * without it there is no interruptible window, so no later upload can get in.
 */
async function fullReflash() {
  // Resolved BEFORE the confirmation, both of these: asking someone to approve an
  // irreversible erase and only then discovering we have nothing to write is the
  // wrong order.
  //
  // An empty editor is the ordinary state of a fresh tab, and a fresh tab is what
  // a fresh board arrives with — so it loads the starter template rather than
  // refusing. A template that will not load still stops the erase.
  if (!getCode().trim()) {
    try {
      await loadTemplate();
    } catch (err) {
      note("flashNote", `Could not load the starter template: ${err.message}`, "err");
      log(`Could not load the template: ${err.message}`, "err");
      return;
    }
  }
  const code = getCode();
  if (
    !confirm(
      "Erase the entire robot and install MicroPython? Its code and saved " +
        "calibration are gone for good.",
    )
  ) {
    return;
  }

  const prog = $("flashProg");
  const fill = $("flashFill");
  prog.hidden = false;
  setBusy(true);
  note("flashNote", "");
  try {
    // setBusy first, so the gate is already shut while this unwinds — otherwise a
    // second click could start a second reflash during the await.
    if (await cancelHandshake()) {
      log("Stopped trying for a REPL — erasing instead", "warn");
    }
    log("Fetching MicroPython image");
    const image = await fetchImage(MICROPYTHON_URL, MICROPYTHON_SHA256);
    log(`Image verified (${image.length} bytes, SHA256 matches)`, "go");

    // Hand the port over completely. This is the ordering the whole design turns
    // on: esptool's waitForUnlock() spins forever on a locked stream, so a reader
    // left open here would hang the page instead of erroring.
    const port = mp.port;
    stopWatching();
    await mp.close();
    owner.release("repl");
    portOpen = false;
    atRepl = false;
    renderConn();

    owner.claim("esptool");
    try {
      // Windows cannot enter the ROM loader from software on this circuit
      // (esptool.js:signalsAreAtomic), so there the board must already be sitting
      // in it — hence the checkbox, and hence "no_reset" rather than a sequence
      // that would spend seven attempts failing.
      const manual = !signalsAreAtomic() || $("flashManual")?.checked === true;
      if (manual) {
        log("Skipping the automatic reset — expecting the board in its bootloader");
      }
      log("Erasing flash and writing MicroPython — do not unplug");
      await flash({
        port,
        images: [{ address: ROBOT_MICROPYTHON_OFFSET, data: image }],
        eraseAll: true,
        resetMode: manual ? "no_reset" : "default_reset",
        // No reset option to pass: esptool.js overrides the library's sequence
        // itself, because esptool-js's ClassicReset cannot enter the bootloader on
        // these boards at all — it moves DTR and RTS one at a time and the (1,1)
        // transient lets the chip boot its own firmware. See the TightReset note
        // in esptool.js for the bench measurements. Either way no button press is
        // needed. Confirmed on an ESP32-D0WD-V3 behind a CP2102 (VID 0x10c4
        // PID 0xEA60); other boards use a CH340 (0x1a86/0x7523), same path.
        onProgress: (pct) => {
          fill.style.width = `${pct}%`;
        },
        onLog: (line) => log(line),
      });
    } finally {
      owner.release("esptool");
    }
    log("MicroPython installed", "go");

    // Let the board actually boot before asking it anything. esptool's hard reset
    // has only just pulsed RTS, and a fresh MicroPython takes a moment to reach
    // its prompt; reconnecting instantly meant the first Ctrl-C landed before
    // there was anything listening.
    await new Promise((r) => setTimeout(r, 1500));

    // Reopen the REPL to put the six files on the fresh filesystem.
    log("Reconnecting to write the robot files");
    if (!(await connect(port))) {
      throw new Error(
        "MicroPython is installed, but the board did not come back at a REPL. " +
          "Unplug it, plug it back in, then use Upload to write the robot files.",
      );
    }
    const bootBody = await fetchLib(BOOT_FILE);
    await mp.writeFile(BOOT_FILE, bootBody);
    log(`Wrote ${BOOT_FILE} — this is what makes future uploads possible`, "go");
    for (const name of LIB_FILES) {
      const body = await fetchLib(name);
      await mp.writeFile(name, body);
      log(`Wrote ${name}`);
    }
    await mp.writeFile("main.py", code);
    log("Wrote main.py", "go");
    dirty = false;

    await mp.softReset();
    watchOutput();
    note("flashNote", "Done. The robot is running MicroPython and your code.");
    $("flashConfirm").value = "";
    renderFlashGate();
  } catch (err) {
    note("flashNote", String(err.message), "err");
    log(`Reflash failed: ${err.message}`, "err");
    // "Failed to connect with the device" is esptool-js's message for "all seven
    // syncs timed out", which on these boards means the chip never left its own
    // firmware — a reset problem, not a port problem. The port opened, so the
    // driver is fine and the driver panel would be the wrong advice; what fixes it
    // is the manual BOOT/RESET. Matched loosely because the string is the
    // library's, not ours.
    if (/failed to connect/i.test(String(err.message))) {
      revealManualBoot();
      log(
        "The board did not enter its bootloader. Do the BOOT/RESET steps now " +
          "shown under the button, then Erase again.",
        "warn",
      );
    }
  } finally {
    setBusy(false);
    prog.hidden = true;
    fill.style.width = "0";
  }
}

/* ── UI plumbing ────────────────────────────────────────────────────────── */

/** @param {string} id @param {string} msg @param {"err"|""} [kind] */
function note(id, msg, kind = "") {
  const el = $(id);
  el.textContent = msg;
  if (kind) {
    el.dataset.kind = kind;
  } else {
    delete el.dataset.kind;
  }
}

/** Lock the actions during a device operation, so two cannot overlap. */
function setBusy(on) {
  busy = on;
  for (const id of ["btnPull", "btnPush", "btnFlash", "btnClearCalib", "btnDisconnect"]) {
    $(id).disabled = on;
  }
  // renderConn re-derives each button from portOpen/atRepl/busy, which is the
  // only place that logic should live.
  if (!on) {
    renderConn();
  }
}

/** @param {"Pull"|"Push"|"Flash"} which */
function selectMode(which) {
  for (const [tab, pane] of [
    ["tabPull", "panePull"],
    ["tabPush", "panePush"],
    ["tabFlash", "paneFlash"],
  ]) {
    const on = tab === `tab${which}`;
    $(tab).setAttribute("aria-selected", String(on));
    $(pane).hidden = !on;
  }
}

/**
 * Open the BOOT/RESET steps.
 *
 * Two callers with genuinely different needs, hence `required`:
 *
 *   Windows, at load — the steps are the ONLY way to flash, so the checkbox is
 *   not a choice and is hidden. Leaving it visible and pre-ticked would claim the
 *   student had done steps they have not even read yet, and leaving it visible and
 *   clear would imply un-ticking it changes something. It does not: the reset mode
 *   is forced by signalsAreAtomic(), not by the box.
 *
 *   After a failed connect anywhere else — the auto-reset is normally right here,
 *   so this is an opt-in, and it is ticked because someone who just read a failure
 *   should not have to hunt for one more control to act on it.
 *
 * Idempotent either way, so the failure path can call it on every attempt.
 *
 * @param {{required?: boolean}} [opts]
 */
function revealManualBoot({ required = false } = {}) {
  const box = $("manualBoot");
  if (box) {
    box.hidden = false;
  }
  const field = $("flashManualField");
  const check = $("flashManual");
  if (field) {
    field.hidden = required;
  }
  if (check) {
    check.checked = !required;
  }
}

function download() {
  const blob = new Blob([getCode()], { type: "text/x-python" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "main.py";
  a.click();
  URL.revokeObjectURL(a.href);
  log("Downloaded main.py");
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

initEditor();
restoreBuffer();
renderBuf();
renderConn();

/**
 * Driver help. Only mounted when the browser could actually open a port —
 * offering install steps to a browser that has no Web Serial at all would point
 * at the wrong problem, and #noSerial already names that one.
 */
let driverHelp = { reveal() {} };

if (!MicroPythonSerial.supported) {
  $("noSerial").hidden = false;
  $("btnConnect").disabled = true;
  log("Web Serial unavailable in this browser", "err");
} else {
  driverHelp = mountDriverHelp({ mount: $("drvHelp"), device: "robot" });
  // On Windows this is not a fallback, it is the only route: Chrome writes DTR and
  // RTS one at a time there, so no software sequence can enter the ROM loader on
  // this board's auto-reset circuit (esptool.js:signalsAreAtomic). Showing the
  // steps before the first failure — rather than after seven timed-out syncs —
  // is the difference between a 30-second detour and an unexplained dead end.
  if (!signalsAreAtomic()) {
    revealManualBoot({ required: true });
  }
}

$("btnConnect").addEventListener("click", async () => {
  try {
    const port = await MicroPythonSerial.request();
    await connect(port);
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      // Covers both "cancelled the dialog" and "the dialog was empty", which the
      // API does not distinguish. An empty list is the case worth helping with,
      // so open the panel and say why rather than only logging a dead end.
      log("No port selected — if the list was empty, the board needs a driver", "warn");
      driverHelp.reveal();
      return;
    }
    log(`Connect failed: ${err.message}`, "err");
  }
});

$("btnDisconnect").addEventListener("click", () => {
  disconnect().catch((err) => log(`Disconnect failed: ${err.message}`, "err"));
});

$("btnPull").addEventListener("click", () => pull());
$("btnPush").addEventListener("click", () => push());
$("btnFlash").addEventListener("click", () => fullReflash());
$("btnClearCalib").addEventListener("click", () => clearCalibration());
$("btnDownload").addEventListener("click", download);
$("btnClearLog").addEventListener("click", () => clearLog());
$("btnStopOut").addEventListener("click", () => {
  stopWatching();
  $("outBox").hidden = true;
});

$("tabPull").addEventListener("click", () => selectMode("Pull"));
$("tabPush").addEventListener("click", () => selectMode("Push"));
$("tabFlash").addEventListener("click", () => selectMode("Flash"));
$("flashConfirm").addEventListener("input", renderFlashGate);

$("btnTemplate").addEventListener("click", async () => {
  if (dirty && !confirm("Replace the editor's contents with the starter template?")) {
    return;
  }
  try {
    await loadTemplate();
  } catch (err) {
    log(`Could not load the template: ${err.message}`, "err");
  }
});

/**
 * After an upload the robot holds the only copy of this code — sessionStorage
 * dies with the tab. Warn on close while there are unsaved edits.
 */
window.addEventListener("beforeunload", (e) => {
  if (dirty && getCode().trim()) {
    e.preventDefault();
    // Browsers show their own wording; the return value only opts in.
    e.returnValue = "";
  }
});

log("Robot code editor ready");
