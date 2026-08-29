import {
  MINICORE_USB_VID,
  MINICORE_USB_PID,
  MC_HID_RID_JOYSTICK,
  MC_HID_RID_ENABLE,
  MC_HID_RID_DISCOVERY,
  MC_HID_RID_PAIR,
  MC_HID_RID_UNPAIR,
  MC_HID_RID_SET_NEUTRAL,
  MC_HID_RID_HEARTBEAT_IN,
  MC_HID_RID_NEUTRAL_IN,
  MC_HID_RID_DISCOVERY_IN,
  MC_HID_RID_DONGLE_STATUS,
  MC_MAX_ROBOTS,
  MC_NEUTRAL_TRIM_MIN_US,
  MC_NEUTRAL_TRIM_MAX_US,
  MC_PROTOCOL_VERSION,
} from "./constants.js";
import {
  encodeJoystickOut,
  encodeEnable,
  encodeDiscoveryOut,
  encodePairOut,
  encodeUnpairOut,
  encodeSetNeutralOut,
  decodeHeartbeatIn,
  decodeNeutralAckIn,
  decodeDiscoveryIn,
  decodeDongleStatus,
  gamepadToJoystick,
} from "./protocol.js";

/** @type {HIDDevice | null} */
let device = null;
let seq = 0;
let raf = 0;
let armed = false;
let wifiChannel = 6;
/**
 * Cleared by the Disconnect button so the automatic path can't immediately undo
 * a deliberate disconnect. Set again by Connect, or by a physical unplug.
 */
let autoReconnect = true;
/** Guards attachDongle against the load-time scan racing the `connect` event. */
let attaching = false;
/** Last discovery request we sent, for the calibration chase's rate limit. */
let lastDiscoveryMs = 0;

/** Robots we've heard from: macKey -> { mac, id, lastSeen, battery, flags } */
const discovered = new Map();
/** Slot index -> Uint8Array(6) | null */
const pairMac = [];
/**
 * Slot index -> true when the driver has typed a neutral that hasn't been
 * applied yet. The robot echoes its calibration unprompted, and renderSlots()
 * runs every second, so without this an incoming echo would overwrite a
 * half-typed value under the cursor. Cleared when an echo confirms what's in the
 * boxes, and when the slot's pairing changes.
 */
const calibDirty = [];

/** Joystick reports sent in the current second, for the rail readout. */
let txCount = 0;
/** Latched so a mismatched dongle logs once, not five times a second. */
let warnedProtocolMismatch = false;

const BROADCAST_MAC = new Uint8Array(6).fill(0xff);
const STALE_MS = 2500;
const DROP_MS = 5000;
const LOG_MAX = 200;

const $ = (id) => document.getElementById(id);

/* ── Activity log ─────────────────────────────────────────────────────────── */

/** @param {string} msg @param {"info"|"go"|"warn"|"err"} kind */
function log(msg, kind = "info") {
  const list = $("log");
  const li = document.createElement("li");
  li.dataset.kind = kind;
  const t = document.createElement("time");
  const d = new Date();
  t.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const span = document.createElement("span");
  span.textContent = msg;
  li.append(t, span);
  list.prepend(li);
  while (list.children.length > LOG_MAX) {
    list.lastElementChild.remove();
  }
}

/* ── Formatting ───────────────────────────────────────────────────────────── */

function macKey(mac) {
  return Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

/** Robots report battery as 0xFF when they have no sensor — say so, don't fake it. */
function batteryText(pct) {
  return pct === undefined || pct === 0xff ? "battery n/a" : `battery ${pct}%`;
}

/* ── Dongle connection ────────────────────────────────────────────────────── */

function setDongleUi(connected) {
  document.body.dataset.link = connected ? "up" : "down";
  $("dongleState").textContent = connected ? "Connected" : "Not connected";
  $("btnDisconnect").disabled = !connected;
  $("btnConnect").disabled = connected;
  $("btnScan").disabled = !connected;
  $("btnArm").disabled = !connected;
  if (!connected) {
    $("chanDisp").textContent = "--";
    $("txRate").textContent = "0";
    $("faultChip").hidden = true;
  }
  renderArm();
  refreshSlotControls();
}

const isDongle = (dev) =>
  dev.vendorId === MINICORE_USB_VID && dev.productId === MINICORE_USB_PID;

/**
 * Bring the link up on an already-chosen device. Shared by the picker and the
 * automatic paths, so an auto-connected dongle lands in exactly the same state
 * as a hand-picked one — including the disable broadcast below, which is the
 * reason this is one function and not two.
 *
 * @returns {Promise<boolean>} false when a link was already up or coming up.
 */
async function attachDongle(dev) {
  // The load-time scan and the `connect` event can both fire for one plug-in,
  // and `await dev.open()` is long enough for the second to arrive mid-flight.
  // Without this guard the loser overwrites `device`, leaking the winner's open
  // handle and its inputreport listener.
  if (attaching || (device && device.opened)) {
    return false;
  }
  attaching = true;
  try {
    await dev.open();
    device = dev;
    device.addEventListener("inputreport", onInputReport);
  } finally {
    attaching = false;
  }
  setDongleUi(true);
  log(`Dongle connected — ${device.productName || "MiniCore"}`, "go");
  // This page starts disarmed, but a robot that stayed powered through a reload
  // is still latched enabled from the previous session. Push our state onto the
  // field before the control loop starts, so the UI and the robots agree.
  await broadcastDisable("link opened");
  // A robot that has already met this dongle will not re-announce its
  // calibration on its own, so ask instead of waiting for an announce that is
  // never coming. See requestCalibration().
  await requestCalibration();
  startGamepadLoop();
  return true;
}

async function connectDongle() {
  if (!("hid" in navigator)) {
    $("noHid").hidden = false;
    log("WebHID unavailable in this browser", "err");
    return;
  }
  const devs = await navigator.hid.requestDevice({
    filters: [{ vendorId: MINICORE_USB_VID, productId: MINICORE_USB_PID }],
  });
  if (!devs.length) {
    log("No dongle selected", "warn");
    return;
  }
  // Picking a dongle by hand is also how you undo an earlier Disconnect.
  autoReconnect = true;
  await attachDongle(devs[0]);
}

/**
 * Connect with no picker and no click, using a dongle this origin has already
 * been granted.
 *
 * getDevices() returns only devices the driver has chosen here before, so it
 * needs no user gesture. That makes every load after the first automatic and
 * leaves the first costing exactly one click: requestDevice() is the only call
 * that can create the grant, and it requires a gesture by design.
 *
 * @returns {Promise<"connected" | "none" | "failed">}
 */
async function autoConnect() {
  if (!("hid" in navigator) || !autoReconnect || (device && device.opened)) {
    return "none";
  }
  let devs = [];
  try {
    devs = await navigator.hid.getDevices();
  } catch (err) {
    log(`Could not list remembered devices: ${err}`, "warn");
    return "failed";
  }
  const dev = devs.find(isDongle);
  if (!dev) {
    return "none";
  }
  try {
    return (await attachDongle(dev)) ? "connected" : "none";
  } catch (err) {
    // Usually another tab already holds it — WebHID allows a single opener.
    log(`Auto-connect failed: ${err} — use Connect dongle`, "warn");
    return "failed";
  }
}

async function disconnectDongle() {
  // Stop the control loop before anything else, so it can't race a send against
  // the closing device.
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  // Never leave robots enabled behind a closing link. Sent unconditionally: a
  // robot may be latched enabled from an earlier session even when armed is
  // false here. Awaited, because device.close() would abort it in flight.
  await broadcastDisable("link closing");
  if (device && device.opened) {
    device.removeEventListener("inputreport", onInputReport);
    await device.close();
  }
  device = null;
  for (let i = 0; i < MC_MAX_ROBOTS; i++) {
    pairMac[i] = null;
  }
  setDongleUi(false);
  renderSlots();
  log("Dongle disconnected");
}

async function sendReport(reportId, data) {
  if (!device || !device.opened) {
    return;
  }
  await device.sendReport(reportId, data);
}

/**
 * Broadcast a discovery request — which is also how we ask for calibration.
 *
 * Robots answer a discovery request with a discovery response *and* a neutral
 * ack, unconditionally. That matters because their unprompted announce is not
 * something a fresh driver station can count on: minibot.py re-arms it only
 * when the robot learns a dongle MAC for the *first* time, and the dongle's MAC
 * survives a page reload. So a robot that was already talking to this dongle
 * before the page loaded spent its announces long ago, and would otherwise sit
 * at "robot: not reported yet" until someone clicked Scan.
 */
async function requestCalibration() {
  // Stamped before the send, not after, so a failure still holds the rate limit
  // and can't turn into a tight retry loop.
  lastDiscoveryMs = Date.now();
  try {
    await sendReport(MC_HID_RID_DISCOVERY, encodeDiscoveryOut(wifiChannel));
  } catch (err) {
    log(`Calibration request failed: ${err}`, "warn");
  }
}

/* ── Inbound reports ──────────────────────────────────────────────────────── */

function touchRobot(mac, id, extra) {
  const k = macKey(mac);
  const prev = discovered.get(k);
  const rec = prev || { mac, id, battery: 0xff, flags: 0 };
  rec.id = id || rec.id;
  rec.lastSeen = Date.now();
  Object.assign(rec, extra);
  discovered.set(k, rec);
  if (!prev) {
    log(`Robot ${rec.id || "(unnamed)"} found — ${k}`, "go");
    renderRobots();
  }
  return rec;
}

function onInputReport(e) {
  const { reportId, data } = e;
  const buf = new Uint8Array(data.buffer);

  if (reportId === MC_HID_RID_HEARTBEAT_IN) {
    const h = decodeHeartbeatIn(buf);
    if (h) {
      touchRobot(h.mac, h.robot_id, {
        battery: h.battery_pct,
        flags: h.status_flags,
      });
    }
  } else if (reportId === MC_HID_RID_NEUTRAL_IN) {
    const nk = decodeNeutralAckIn(buf);
    if (nk) {
      const k = macKey(nk.mac);
      const prev = discovered.get(k);
      // Robots re-announce for reliability (the first few heartbeats, and every
      // scan), so only say something when the values actually moved. Otherwise
      // one power-up would put three identical lines in the log per robot.
      const changed =
        !prev ||
        prev.neutralLeft !== nk.neutral_left_us ||
        prev.neutralRight !== nk.neutral_right_us ||
        prev.neutralStored !== nk.stored;

      // Post-clamp values straight from the robot, so the readout shows what
      // actually landed rather than what we asked for.
      const rec = touchRobot(nk.mac, null, {
        neutralLeft: nk.neutral_left_us,
        neutralRight: nk.neutral_right_us,
        neutralStored: nk.stored,
      });

      // Report on an unpaired robot too. Announces arrive at power-up and in
      // answer to a scan — both before anyone has paired a slot — so keying this
      // on a pairing would make the whole announce invisible.
      const slotIdx = pairMac.findIndex((m) => m && macKey(m) === k);
      if (slotIdx >= 0) {
        const slot = $(`slot-${slotIdx}`);
        // Only an echo matching the boxes means this driver's edit landed.
        // Anything else is a clamp or someone else's change, and must not wipe
        // an edit still in progress.
        if (
          Number(slot.querySelector("input.calib-left").value) === nk.neutral_left_us &&
          Number(slot.querySelector("input.calib-right").value) === nk.neutral_right_us
        ) {
          calibDirty[slotIdx] = false;
        }
      }
      if (changed) {
        const who = slotIdx >= 0 ? `Slot ${slotIdx}` : rec.id || k;
        log(
          `${who}: neutral ${nk.neutral_left_us}/${nk.neutral_right_us} µs` +
            (nk.stored ? "" : " (not saved — a reset will revert it)"),
          nk.stored ? "go" : "warn",
        );
      }
      renderSlots();
    }
  } else if (reportId === MC_HID_RID_DISCOVERY_IN) {
    const d = decodeDiscoveryIn(buf);
    if (d) {
      touchRobot(d.mac, d.robot_id, {});
    }
  } else if (reportId === MC_HID_RID_DONGLE_STATUS) {
    const s = decodeDongleStatus(buf);
    if (s) {
      wifiChannel = s.wifi_channel;
      $("chanDisp").textContent = String(s.wifi_channel);
      // A dongle built against a different minicore_protocol.h than this page
      // was. Report ids and packet layouts may not line up; say so once rather
      // than letting it surface as a feature that silently does nothing.
      if (s.protocol_version !== MC_PROTOCOL_VERSION && !warnedProtocolMismatch) {
        warnedProtocolMismatch = true;
        log(
          `Dongle firmware is protocol v${s.protocol_version}, this page expects ` +
            `v${MC_PROTOCOL_VERSION} — reflash the dongle (scripts/flash-dongle)`,
          "err",
        );
      }
      // error_flags bit0 = ESP-NOW send failure on the dongle.
      const fault = (s.error_flags & 1) !== 0;
      const chip = $("faultChip");
      if (fault !== !chip.hidden) {
        chip.hidden = !fault;
        if (fault) log("Dongle reports ESP-NOW send failure", "err");
      }
    }
  }
}

/* ── Arm / disarm ─────────────────────────────────────────────────────────── */

function renderArm() {
  const connected = !!(device && device.opened);
  const pairedCount = pairMac.filter(Boolean).length;
  document.body.dataset.armed = String(armed);
  $("armState").textContent = armed ? "Enabled" : "Disabled";
  $("btnArm").textContent = armed ? "Disable all robots" : "Enable all robots";

  let read;
  if (!connected) {
    read = "Connect the dongle to enable robots.";
  } else if (armed) {
    read =
      pairedCount === 1
        ? "1 robot is live and following its gamepad."
        : `${pairedCount} robots are live and following their gamepads.`;
  } else if (pairedCount === 0) {
    read = "Assign a robot to a slot, then enable.";
  } else {
    read = `${pairedCount} ${pairedCount === 1 ? "slot" : "slots"} ready. Motors are stopped.`;
  }
  $("armRead").textContent = read;
}

/**
 * Push enable=off to every robot in range, whatever the UI currently believes.
 * A robot latches its enabled flag until told otherwise, so "we think we're
 * disarmed" is not a reason to skip sending — that assumption is exactly how a
 * robot ends up driving from a freshly loaded page.
 */
async function broadcastDisable(reason) {
  armed = false;
  renderArm();
  renderSlots();
  if (!device || !device.opened) {
    // No link to send down. Say so rather than logging a stop that never went out.
    log(`Disarmed locally — no link to disable robots${reason ? ` (${reason})` : ""}`, "warn");
    return;
  }
  try {
    await sendReport(MC_HID_RID_ENABLE, encodeEnable(false, BROADCAST_MAC));
    log(`Disabled — motors stopped${reason ? ` (${reason})` : ""}`, "warn");
  } catch (err) {
    log(`Disable command failed: ${err}`, "err");
  }
}

async function setArmed(on, reason) {
  if (on === armed) {
    return;
  }
  if (!on) {
    await broadcastDisable(reason);
    return;
  }
  armed = true;
  renderArm();
  renderSlots();
  try {
    await sendReport(MC_HID_RID_ENABLE, encodeEnable(true, BROADCAST_MAC));
    log("Enabled — all robots live", "go");
  } catch (err) {
    log(`Enable command failed: ${err}`, "err");
  }
}

/* ── Slots ────────────────────────────────────────────────────────────────── */

function buildSlots() {
  const root = $("slots");
  root.innerHTML = "";
  for (let i = 0; i < MC_MAX_ROBOTS; i++) {
    pairMac[i] = null;
    calibDirty[i] = false;
    const slot = document.createElement("section");
    slot.className = "slot";
    slot.id = `slot-${i}`;
    slot.dataset.paired = "false";
    slot.dataset.state = "empty";
    slot.innerHTML = `
      <header class="slot__head">
        <span class="slot__idx">Slot ${i}</span>
        <button type="button" class="btn btn--sm btn-release" data-idx="${i}" disabled>Release</button>
      </header>
      <p class="slot__name" id="slot-name-${i}">No robot</p>
      <p class="slot__status" id="slot-status-${i}">
        <span class="dot" aria-hidden="true"></span><span>Empty</span>
      </p>
      <label class="slot__field">
        <span>Robot</span>
        <select class="slot-pair" data-idx="${i}" aria-label="Robot for slot ${i}">
          <option value="">— none —</option>
        </select>
      </label>
      <label class="slot__field">
        <span>Gamepad</span>
        <select class="slot-gamepad" data-idx="${i}" aria-label="Gamepad for slot ${i}">
          <option value="">— none —</option>
        </select>
      </label>
      <div class="slot__calib">
        <span class="calib__title">Neutral µs</span>
        <label class="calib__field">
          <span>L</span>
          <input type="number" class="calib-left" data-idx="${i}"
                 min="${MC_NEUTRAL_TRIM_MIN_US}" max="${MC_NEUTRAL_TRIM_MAX_US}" step="5"
                 aria-label="Left motor neutral for slot ${i}" disabled>
        </label>
        <label class="calib__field">
          <span>R</span>
          <input type="number" class="calib-right" data-idx="${i}"
                 min="${MC_NEUTRAL_TRIM_MIN_US}" max="${MC_NEUTRAL_TRIM_MAX_US}" step="5"
                 aria-label="Right motor neutral for slot ${i}" disabled>
        </label>
        <button type="button" class="btn btn--sm btn-calib" data-idx="${i}" disabled>Apply</button>
        <p class="calib__read" id="calib-read-${i}"></p>
      </div>
      <p class="slot__mac" id="slot-mac-${i}"></p>
      <div class="sticks" aria-hidden="true">
        <div class="stick">
          <span>Left</span>
          <div class="stick__track"><div class="stick__fill" id="stick-l-${i}"></div></div>
        </div>
        <div class="stick">
          <span>Right</span>
          <div class="stick__track"><div class="stick__fill" id="stick-r-${i}"></div></div>
        </div>
      </div>`;
    root.appendChild(slot);
  }

  // Choosing a robot pairs it immediately — one action instead of select-then-Pair.
  root.querySelectorAll("select.slot-pair").forEach((sel) => {
    sel.addEventListener("change", () => pairSlot(Number(sel.dataset.idx), sel.value));
  });
  root.querySelectorAll(".btn-release").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const sel = root.querySelector(`select.slot-pair[data-idx="${idx}"]`);
      if (sel) sel.value = "";
      pairSlot(idx, "");
    });
  });
  root.querySelectorAll("select.slot-gamepad").forEach((sel) => {
    sel.addEventListener("change", () => renderSlots());
  });

  // Typing marks the slot dirty so the robot's echo stops overwriting the boxes
  // until the value has actually been applied.
  root.querySelectorAll("input.calib-left, input.calib-right").forEach((inp) => {
    inp.addEventListener("input", () => {
      calibDirty[Number(inp.dataset.idx)] = true;
    });
  });
  // The ONLY path that puts neutral values on the wire. The control loop in
  // startGamepadLoop() never touches them, so calibration is strictly a
  // click-driven action rather than something streamed at frame rate.
  root.querySelectorAll(".btn-calib").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyNeutral(Number(btn.dataset.idx)).catch((err) =>
        log(`Neutral apply failed: ${err}`, "err"),
      );
    });
  });
}

/** Read one calibration box, or null if it isn't a usable pulse width. */
function readCalibInput(sel) {
  const raw = sel && sel.value !== "" ? Number(sel.value) : NaN;
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
    return null;
  }
  // Refuse rather than silently clamp. The dongle and robot both clamp as a
  // backstop, but a driver who typed 1800 should be told the value was rejected,
  // not left believing 1800 is what the robot is running.
  if (raw < MC_NEUTRAL_TRIM_MIN_US || raw > MC_NEUTRAL_TRIM_MAX_US) {
    return null;
  }
  return raw;
}

async function applyNeutral(idx) {
  if (!pairMac[idx]) {
    return;
  }
  const slot = $(`slot-${idx}`);
  const left = readCalibInput(slot.querySelector("input.calib-left"));
  const right = readCalibInput(slot.querySelector("input.calib-right"));
  if (left === null || right === null) {
    log(
      `Slot ${idx}: neutral must be a whole number of µs, ${MC_NEUTRAL_TRIM_MIN_US}–${MC_NEUTRAL_TRIM_MAX_US}`,
      "warn",
    );
    return;
  }
  try {
    await sendReport(MC_HID_RID_SET_NEUTRAL, encodeSetNeutralOut(idx, left, right));
    log(`Slot ${idx}: neutral ${left}/${right} µs sent`);
  } catch (err) {
    log(`Neutral send failed on slot ${idx}: ${err}`, "err");
  }
}

async function pairSlot(idx, key) {
  // Whatever the slot's calibration boxes hold belongs to the robot leaving it,
  // so drop the edit state either way and let the new occupant's echo refill.
  calibDirty[idx] = false;
  if (!key) {
    pairMac[idx] = null;
    const slot = $(`slot-${idx}`);
    slot.querySelector("input.calib-left").value = "";
    slot.querySelector("input.calib-right").value = "";
    try {
      await sendReport(MC_HID_RID_UNPAIR, encodeUnpairOut(idx));
      log(`Slot ${idx} released`);
    } catch (err) {
      log(`Release failed on slot ${idx}: ${err}`, "err");
    }
    renderSlots();
    renderArm();
    return;
  }
  const mac6 = new Uint8Array(key.split(":").map((h) => parseInt(h, 16)));
  pairMac[idx] = mac6;
  try {
    await sendReport(MC_HID_RID_PAIR, encodePairOut(idx, mac6));
    const rec = discovered.get(key);
    log(`Slot ${idx} → ${rec?.id || key}`, "go");
  } catch (err) {
    log(`Pair failed on slot ${idx}: ${err}`, "err");
  }
  renderSlots();
  renderArm();
}

function refreshSlotControls() {
  const connected = !!(device && device.opened);
  document.querySelectorAll("select.slot-pair").forEach((sel) => {
    sel.disabled = !connected;
  });
  // Calibration needs both a link and a robot in the slot: the dongle resolves
  // the target from its own pairing table, so an unpaired slot has nowhere to
  // send. Not gated on `armed` — you calibrate by watching the wheels creep at
  // centered sticks, which means doing it while the robot is enabled.
  for (let i = 0; i < MC_MAX_ROBOTS; i++) {
    const usable = connected && !!pairMac[i];
    const slot = $(`slot-${i}`);
    if (!slot) continue;
    slot.querySelectorAll("input.calib-left, input.calib-right, .btn-calib").forEach((el) => {
      el.disabled = !usable;
    });
  }
}

/** Paint per-slot identity and status from real robot reports. */
function renderSlots() {
  const now = Date.now();
  for (let i = 0; i < MC_MAX_ROBOTS; i++) {
    const slot = $(`slot-${i}`);
    if (!slot) continue;
    const mac = pairMac[i];
    const rec = mac ? discovered.get(macKey(mac)) : null;
    const gpSel = slot.querySelector("select.slot-gamepad");
    const hasGamepad = !!(gpSel && gpSel.value !== "");

    slot.dataset.paired = mac ? "true" : "false";
    slot.querySelector(".btn-release").disabled = !mac;
    $(`slot-name-${i}`).textContent = mac ? rec?.id || "(unnamed)" : "No robot";
    $(`slot-mac-${i}`).textContent = mac ? macKey(mac) : "";

    let state = "empty";
    let label = "Empty";
    if (mac) {
      const age = rec ? now - rec.lastSeen : Infinity;
      // status_flags bit0 is the robot's own view of being enabled.
      const robotEnabled = !!rec && (rec.flags & 1) !== 0;
      if (!rec || age > STALE_MS) {
        state = "stale";
        label = "No heartbeat";
      } else if (armed) {
        state = "live";
        label = robotEnabled
          ? `Live · ${batteryText(rec.battery)}`
          : `Enabling · ${batteryText(rec.battery)}`;
      } else if (robotEnabled) {
        // Believe the robot over our own state: it reports itself enabled while
        // we think we're disarmed, so say so rather than painting "Standby".
        state = "live";
        label = `Still enabled · ${batteryText(rec.battery)}`;
      } else if (!hasGamepad) {
        state = "standby";
        label = `Needs gamepad · ${batteryText(rec.battery)}`;
      } else {
        state = "standby";
        label = `Standby · ${batteryText(rec.battery)}`;
      }
    }
    slot.dataset.state = state;
    slot.dataset.live = String(state === "live");
    const status = $(`slot-status-${i}`);
    status.lastElementChild.textContent = label;

    // Calibration: the boxes are what you intend to send, the readout is what
    // the robot says it is running. Keeping them separate is what lets the echo
    // stay live without ever fighting the cursor.
    const readEl = $(`calib-read-${i}`);
    const hasEcho = !!rec && rec.neutralLeft !== undefined;
    if (!mac) {
      readEl.textContent = "";
    } else if (hasEcho) {
      readEl.textContent =
        `robot: ${rec.neutralLeft} / ${rec.neutralRight} µs` +
        (rec.neutralStored ? "" : " · not saved");
    } else {
      readEl.textContent = "robot: not reported yet";
    }
    readEl.dataset.unsaved = String(hasEcho && !rec.neutralStored);
    if (hasEcho && !calibDirty[i]) {
      slot.querySelector("input.calib-left").value = String(rec.neutralLeft);
      slot.querySelector("input.calib-right").value = String(rec.neutralRight);
    }
  }
  refreshSlotControls();
}

/* ── Robot + gamepad lists ────────────────────────────────────────────────── */

function renderRobots() {
  const ul = $("robotList");
  ul.innerHTML = "";
  for (const [k, v] of discovered) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "r-name";
    name.textContent = v.id || "(unnamed)";
    const mac = document.createElement("span");
    mac.className = "r-mac";
    mac.textContent = k.slice(-8);
    li.append(name, mac);
    ul.appendChild(li);
  }
  $("robotEmpty").hidden = discovered.size > 0;
  $("seenCount").textContent = String(discovered.size);

  // Keep every slot's robot menu in sync without losing the current choice.
  document.querySelectorAll("select.slot-pair").forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">— none —</option>';
    for (const [k, v] of discovered) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = v.id || k;
      sel.appendChild(opt);
    }
    sel.value = cur;
  });
  refreshSlotControls();
}

function renderGamepads() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  const list = $("gamepadList");
  list.innerHTML = "";
  let count = 0;

  for (let i = 0; i < gps.length; i++) {
    const gp = gps[i];
    if (!gp) continue;
    count++;
    const li = document.createElement("li");
    li.id = `gp-item-${i}`;
    li.dataset.active = "false";
    const idx = document.createElement("span");
    idx.className = "g-idx";
    idx.textContent = String(i);
    const name = document.createElement("span");
    name.className = "g-name";
    name.textContent = gp.id;
    li.append(idx, name);
    list.appendChild(li);
  }
  $("gamepadEmpty").hidden = count > 0;

  document.querySelectorAll("select.slot-gamepad").forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">— none —</option>';
    for (let i = 0; i < gps.length; i++) {
      if (!gps[i]) continue;
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${i}: ${gps[i].id}`;
      sel.appendChild(opt);
    }
    sel.value = cur;
  });
  renderSlots();
}

window.addEventListener("gamepadconnected", (e) => {
  log(`Gamepad ${e.gamepad.index} connected — ${e.gamepad.id}`);
  renderGamepads();
});
window.addEventListener("gamepaddisconnected", (e) => {
  log(`Gamepad ${e.gamepad.index} disconnected`, "warn");
  renderGamepads();
});

/* ── Control loop ─────────────────────────────────────────────────────────── */

function setStick(id, value) {
  const el = $(id);
  if (!el) return;
  // Centre-anchored bar: grow left or right from the midline.
  const pct = Math.max(-1, Math.min(1, value)) * 50;
  el.style.left = pct < 0 ? `${50 + pct}%` : "50%";
  el.style.width = `${Math.abs(pct)}%`;
}

function startGamepadLoop() {
  const tick = async () => {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];

    // Light up any gamepad the driver is actually touching.
    for (let i = 0; i < gps.length; i++) {
      const gp = gps[i];
      if (!gp) continue;
      const active =
        gp.axes.some((a) => Math.abs(a) > 0.12) || gp.buttons.some((b) => b.pressed);
      const el = $(`gp-item-${i}`);
      if (el) el.dataset.active = String(active);
    }

    if (!device || !device.opened) {
      raf = requestAnimationFrame(tick);
      return;
    }

    for (let slot = 0; slot < MC_MAX_ROBOTS; slot++) {
      const sel = document.querySelector(`select.slot-gamepad[data-idx="${slot}"]`);
      const gp = sel && sel.value !== "" ? gps[Number(sel.value)] : null;

      // Mirror the sticks whether or not we're armed, so wiring can be checked safely.
      setStick(`stick-l-${slot}`, gp ? -(gp.axes[1] ?? 0) : 0);
      setStick(`stick-r-${slot}`, gp ? -(gp.axes[3] ?? 0) : 0);

      if (!pairMac[slot] || !gp) {
        continue;
      }
      // Stick values only leave the station when armed. Disarmed slots stream a
      // neutral packet rather than silence: silence would leave the robot's
      // 250 ms failsafe as the only thing stopping the motors, and a neutral
      // command stops them outright even if the enable latch is somehow stuck.
      const joy = gamepadToJoystick(++seq, armed ? gp : null, null);
      try {
        await sendReport(MC_HID_RID_JOYSTICK, encodeJoystickOut(slot, joy));
        txCount++;
      } catch (err) {
        log(`Joystick send failed: ${err}`, "err");
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */

$("btnConnect").addEventListener("click", () => {
  connectDongle().catch((err) => log(`Connect failed: ${err}`, "err"));
});
$("btnDisconnect").addEventListener("click", () => {
  // A deliberate disconnect has to stick: the dongle is still plugged in and
  // still granted, so the next auto-connect trigger would otherwise undo it.
  autoReconnect = false;
  disconnectDongle().catch((err) => log(`Disconnect failed: ${err}`, "err"));
});
$("btnArm").addEventListener("click", () => setArmed(!armed));
$("btnClearLog").addEventListener("click", () => {
  $("log").innerHTML = "";
});

// Scan was specified and handled by the dongle, but never reachable from the UI.
$("btnScan").addEventListener("click", async () => {
  try {
    lastDiscoveryMs = Date.now();
    await sendReport(MC_HID_RID_DISCOVERY, encodeDiscoveryOut(wifiChannel));
    log(`Scanning channel ${wifiChannel}…`);
  } catch (err) {
    log(`Scan failed: ${err}`, "err");
  }
});

// Emergency stop: Space or Esc always disables, from anywhere on the page.
window.addEventListener("keydown", (e) => {
  const isPanic = e.code === "Space" || e.key === "Escape";
  if (!isPanic || e.repeat) {
    return;
  }
  const el = e.target;
  const typing =
    el instanceof HTMLElement &&
    (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  if (typing) {
    return;
  }
  // Space would otherwise scroll or re-trigger a focused button.
  e.preventDefault();
  // Not gated on `armed`: the panic key must reach a robot that is latched
  // enabled from a previous session, which is precisely when the UI reads
  // disarmed and the driver is reaching for this key.
  broadcastDisable("keyboard stop").catch(() => {});
});

// A reload or closed tab must not leave robots latched enabled. This is
// best-effort — the page may die before the send lands, which is why the
// control loop gates on `armed` and connect re-syncs the field.
window.addEventListener("pagehide", () => {
  // Drop our own armed state too, not just the robots': on a back/forward-cache
  // restore this page keeps running, and it must not come back claiming to be
  // enabled — or streaming live stick values — after disabling the field.
  const wasLive = device && device.opened;
  armed = false;
  renderArm();
  if (wasLive) {
    sendReport(MC_HID_RID_ENABLE, encodeEnable(false, BROADCAST_MAC)).catch(() => {});
  }
});

// A dongle unplugged mid-match must not leave the UI claiming robots are live.
if ("hid" in navigator) {
  navigator.hid.addEventListener("disconnect", (e) => {
    if (!isDongle(e.device)) {
      return;
    }
    // A physical unplug clears an earlier Disconnect: pulling the dongle and
    // putting it back is an unambiguous "use this again", and shouldn't need
    // the button pressed as well.
    autoReconnect = true;
    if (device && e.device === device) {
      log("Dongle unplugged", "err");
      // The device is already gone — the disable send inside will no-op.
      disconnectDongle().catch(() => {});
    }
  });
  // Plugged in while the page was already open — come up without a click.
  navigator.hid.addEventListener("connect", (e) => {
    if (!isDongle(e.device)) {
      return;
    }
    autoConnect().catch(() => {});
  });
} else {
  $("noHid").hidden = false;
  $("btnConnect").disabled = true;
}

// How long to wait before re-asking a robot that owes us its calibration.
const CALIB_CHASE_MS = 3000;

// Age out robots we've stopped hearing from; repaint staleness every second.
setInterval(() => {
  const now = Date.now();
  let dropped = false;
  for (const [k, v] of discovered.entries()) {
    if (now - v.lastSeen > DROP_MS) {
      // Keep a slot's pairing through a dropout — a robot that browns out
      // mid-match should come back to its slot, not need re-pairing. The slot
      // reports "No heartbeat" until it returns.
      const held = pairMac.some((m) => m && macKey(m) === k);
      if (held) {
        continue;
      }
      discovered.delete(k);
      dropped = true;
      log(`Lost ${v.id || k}`, "warn");
    }
  }
  if (dropped) {
    renderRobots();
    renderArm();
  }
  $("txRate").textContent = String(txCount);
  txCount = 0;
  renderSlots();

  // Chase the calibration of any robot that hasn't reported one. Covers the ack
  // being lost (ESP-NOW does not retry), and a robot that powers up into an
  // already-running station. Stops asking the moment every robot has answered.
  if (device && device.opened && now - lastDiscoveryMs >= CALIB_CHASE_MS) {
    let missing = false;
    for (const v of discovered.values()) {
      if (v.neutralLeft === undefined) {
        missing = true;
        break;
      }
    }
    if (missing) {
      requestCalibration();
    }
  }
}, 1000);

// The robot's enable flag expires after MC_ENABLE_TIMEOUT_MS (3 s) so it can't
// stay latched behind a dead station. Keep re-asserting it while armed — twice
// per expiry window, since ESP-NOW broadcasts are unacknowledged and a single
// lost frame must not stand the field down mid-match.
const ENABLE_REASSERT_MS = 500;
setInterval(() => {
  if (armed && device && device.opened) {
    sendReport(MC_HID_RID_ENABLE, encodeEnable(true, BROADCAST_MAC)).catch(() => {});
  }
}, ENABLE_REASSERT_MS);

buildSlots();
renderRobots();
renderGamepads();
setDongleUi(false);
log("Driver station ready");

// Reconnect to a dongle this browser already knows, so the usual case is to
// open the page and drive. The button remains the fallback — and the only way
// to grant a dongle the first time.
autoConnect()
  .then((status) => {
    if (status === "none" && !(device && device.opened)) {
      log('No remembered dongle — click "Connect dongle" once; later loads reconnect on their own');
    }
  })
  .catch(() => {});
