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
import { MicroPythonSerial, SerialError } from "./serial.js";
import { mountDriverHelp } from "./drivers.js";
import { PortOwner, flash, fetchImage, ROBOT_MICROPYTHON_OFFSET } from "./esptool.js";

/** The five files flash-robot.sh:193 uploads, in its order. */
const LIB_FILES = ["minibot.py", "minibot_config.py", "display.py", "ssd1306.py"];
/** boot.py is the sixth, written only on a full reflash — no script ever sends
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
 * `atRepl`   — the board answered the raw-REPL handshake.
 *
 * A board with no MicroPython on it opens fine and never reaches a REPL. Gating
 * full reflash on `atRepl` would disable it on exactly the boards it exists for,
 * so pull/upload require `atRepl` while reflash requires only `portOpen`.
 */
let portOpen = false;
let atRepl = false;
/**
 * True while a device operation owns the port.
 *
 * connect() is awaited inside an async click handler, so its 5-attempt REPL loop
 * runs for ~30 s WITHOUT blocking anything. renderFlashGate() would open the gate
 * as soon as portOpen flipped, so a reflash could start while those retries were
 * still writing Ctrl-C to the same port. PortOwner does not catch this: connect()
 * claims "repl" and fullReflash() releases "repl", so the claim looks satisfied.
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
  $("portState").textContent = atRepl
    ? "Connected"
    : portOpen
      ? "Port open — no REPL"
      : "Not connected";
  $("btnConnect").disabled = portOpen;
  $("btnDisconnect").disabled = !portOpen;
  // These three all execute Python on the board, so they need a live REPL.
  for (const id of ["btnPull", "btnPush", "btnClearCalib"]) {
    $(id).disabled = !atRepl;
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
 * @param {SerialPort} port
 * @returns {Promise<boolean>} true when the REPL was reached
 */
async function connect(port) {
  owner.claim("repl");
  busy = true;
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
    busy = false;
    renderConn();
    throw err;
  }
  try {
    await mp.enterRawWithRetry((m) => log(m, "warn"));
    atRepl = true;
    log("At the robot's REPL", "go");
    return true;
  } catch (err) {
    atRepl = false;
    log(`No REPL on this board: ${err.message}`, "warn");
    log(
      "If this board has never had MicroPython on it, use Reflash — that is what " +
        "it is for. Otherwise unplug and retry.",
      "warn",
    );
    return false;
  } finally {
    // Only now is the port genuinely idle, so only now may reflash have it.
    busy = false;
    renderConn();
  }
}

async function disconnect() {
  stopWatching();
  await mp.close();
  owner.release("repl");
  portOpen = false;
  atRepl = false;
  renderConn();
  log("Disconnected");
}

/* ── Pull ───────────────────────────────────────────────────────────────── */

async function pull() {
  if (dirty && !confirm("Replace the editor's contents with the robot's main.py?")) {
    return;
  }
  note("pullNote", "");
  try {
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
  try {
    await mp.execOrThrow("import os\ntry:\n os.remove('calib.json')\nexcept OSError:\n pass");
    note("calibNote", "Cleared. Reset the robot for main.py's values to take effect.");
    log("Saved calibration cleared", "go");
    await readCalibration();
  } catch (err) {
    note("calibNote", String(err.message), "err");
    log(`Could not clear calibration: ${err.message}`, "err");
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
  stopWatching();
  const prog = $("pushProg");
  const fill = $("pushFill");
  prog.hidden = false;
  setBusy(true);
  try {
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
  // portOpen, not atRepl: this is the tool for a board that has no REPL.
  // `!busy` matters as much: see the note on `busy`.
  $("btnFlash").disabled = !(portOpen && typed && !busy);
  // Say WHICH precondition is missing. A disabled button next to a correctly
  // typed confirmation reads as a broken page, and the one thing a student
  // cannot deduce is that the gate has two halves.
  if (!portOpen) {
    note("flashNote", "Connect the robot first — then type ERASE.");
  } else if (!typed) {
    note("flashNote", 'Type ERASE above to unlock the button.');
  } else if (!$("flashNote").dataset.kind) {
    note("flashNote", "Ready. This erases everything on the board.");
  }
}

/**
 * Erase, write MicroPython, then write all SIX files — the five the scripts send
 * plus boot.py. This is the only path that ever puts boot.py on a board, and
 * without it there is no interruptible window, so no later upload can get in.
 */
async function fullReflash() {
  // Checked BEFORE the confirmation: asking someone to approve an irreversible
  // erase and only then telling them to load code is the wrong order.
  const code = getCode();
  if (!code.trim()) {
    note("flashNote", "Load a main.py first — the robot will have no code otherwise.", "err");
    return;
  }
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
      log("Erasing flash and writing MicroPython — do not unplug");
      await flash({
        port,
        images: [{ address: ROBOT_MICROPYTHON_OFFSET, data: image }],
        eraseAll: true,
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
    const res = await fetch("templates/main.py");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    setCode(await res.text());
    log("Loaded the starter template");
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
