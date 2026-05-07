import {
  MINICORE_USB_VID,
  MINICORE_USB_PID,
  MC_HID_RID_JOYSTICK,
  MC_HID_RID_ENABLE,
  MC_HID_RID_DISCOVERY,
  MC_HID_RID_PAIR,
  MC_HID_RID_UNPAIR,
  MC_HID_RID_HEARTBEAT_IN,
  MC_HID_RID_DISCOVERY_IN,
  MC_HID_RID_DONGLE_STATUS,
  MC_MAX_ROBOTS,
} from "./constants.js";
import {
  encodeJoystickOut,
  encodeEnable,
  encodeDiscoveryOut,
  encodePairOut,
  encodeUnpairOut,
  decodeHeartbeatIn,
  decodeDiscoveryIn,
  decodeDongleStatus,
  gamepadToJoystick,
} from "./protocol.js";

/** @type {HIDDevice | null} */
let device = null;
let seq = 0;
let raf = 0;

const discovered = new Map();
const pairMac = [];

function log(...args) {
  const el = document.getElementById("log");
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  el.textContent = `${line}\n` + el.textContent.slice(0, 8000);
}

function setDongleUi(connected) {
  document.getElementById("dongleState").textContent = connected ? "connected" : "disconnected";
  document.getElementById("dongleState").className = "badge" + (connected ? " ok" : "");
  document.getElementById("btnScan").disabled = !connected;
  document.getElementById("chkGlobalEn").disabled = !connected;
  document.getElementById("btnDisconnect").disabled = !connected;
  document.getElementById("btnConnect").disabled = connected;
}

function macKey(mac) {
  return Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

function onInputReport(e) {
  const { reportId, data } = e;
  const buf = new Uint8Array(data.buffer);
  if (reportId === MC_HID_RID_HEARTBEAT_IN) {
    const h = decodeHeartbeatIn(buf);
    if (h) {
      log("heartbeat", h.robot_id, h.battery_pct);
    }
  } else if (reportId === MC_HID_RID_DISCOVERY_IN) {
    const d = decodeDiscoveryIn(buf);
    if (d) {
      const k = macKey(d.mac);
      discovered.set(k, { mac: d.mac, id: d.robot_id });
      renderRobots();
      log("discovered", d.robot_id, k);
    }
  } else if (reportId === MC_HID_RID_DONGLE_STATUS) {
    const s = decodeDongleStatus(buf);
    if (s) {
      document.getElementById("chanDisp").textContent = String(s.wifi_channel);
    }
  }
}

async function connectDongle() {
  if (!("hid" in navigator)) {
    alert("WebHID not available. Use Chrome or Edge over HTTPS or localhost.");
    return;
  }
  const devs = await navigator.hid.requestDevice({
    filters: [{ vendorId: MINICORE_USB_VID, productId: MINICORE_USB_PID }],
  });
  if (!devs.length) {
    return;
  }
  device = devs[0];
  await device.open();
  device.addEventListener("inputreport", onInputReport);
  setDongleUi(true);
  log("opened", device.productName);
  startGamepadLoop();
}

function disconnectDongle() {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  if (device && device.opened) {
    device.removeEventListener("inputreport", onInputReport);
    device.close();
  }
  device = null;
  setDongleUi(false);
}

async function sendReport(reportId, data) {
  if (!device || !device.opened) {
    return;
  }
  await device.sendReport(reportId, data);
}

function renderRobots() {
  const ul = document.getElementById("robotList");
  ul.innerHTML = "";
  for (const [, v] of discovered) {
    const li = document.createElement("li");
    li.textContent = `${v.id} — ${macKey(v.mac)}`;
    ul.appendChild(li);
  }
  const selects = document.querySelectorAll("select.slot-pair");
  selects.forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">— none —</option>';
    for (const [, v] of discovered) {
      const opt = document.createElement("option");
      opt.value = macKey(v.mac);
      opt.textContent = `${v.id}`;
      sel.appendChild(opt);
    }
    sel.value = cur;
  });
}

function buildSlots() {
  const root = document.getElementById("slots");
  root.innerHTML = "";
  for (let i = 0; i < MC_MAX_ROBOTS; i++) {
    pairMac[i] = null;
    const row = document.createElement("div");
    row.className = "slot-row";
    row.innerHTML = `<span>Slot ${i}</span>
      <select class="slot-pair" data-idx="${i}"><option value="">— robot —</option></select>
      <select class="slot-gamepad" data-idx="${i}"><option value="">— gamepad —</option></select>
      <button type="button" class="btn-pair" data-idx="${i}">Pair</button>`;
    root.appendChild(row);
  }
  root.querySelectorAll(".btn-pair").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.getAttribute("data-idx"));
      const sel = root.querySelector(`select.slot-pair[data-idx="${idx}"]`);
      const v = sel.value;
      if (!v || !device) {
        await sendReport(MC_HID_RID_UNPAIR, encodeUnpairOut(idx));
        pairMac[idx] = null;
        log("unpair slot", idx);
        return;
      }
      const mac = v.split(":").map((h) => parseInt(h, 16));
      const mac6 = new Uint8Array(mac);
      await sendReport(MC_HID_RID_PAIR, encodePairOut(idx, mac6));
      pairMac[idx] = mac6;
      log("pair slot", idx, v);
    });
  });
}

function renderGamepads() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  const list = document.getElementById("gamepadList");
  if (!list) return;
  list.innerHTML = "";
  
  const selects = document.querySelectorAll("select.slot-gamepad");
  selects.forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">— gamepad —</option>';
    for (let i = 0; i < gps.length; i++) {
      const gp = gps[i];
      if (gp) {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = `${i}: ${gp.id}`;
        sel.appendChild(opt);
      }
    }
    sel.value = cur;
  });

  for (let i = 0; i < gps.length; i++) {
    const gp = gps[i];
    if (gp) {
      const li = document.createElement("li");
      li.id = `gp-item-${i}`;
      li.textContent = `Index ${i}: ${gp.id}`;
      list.appendChild(li);
    }
  }
}

window.addEventListener("gamepadconnected", renderGamepads);
window.addEventListener("gamepaddisconnected", renderGamepads);

function startGamepadLoop() {
  const tick = async () => {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    
    // Update active visual state for gamepads
    for (let i = 0; i < gps.length; i++) {
      const gp = gps[i];
      if (gp) {
        let active = false;
        for (let j = 0; j < gp.axes.length; j++) {
          if (Math.abs(gp.axes[j]) > 0.1) active = true;
        }
        for (let j = 0; j < gp.buttons.length; j++) {
          if (gp.buttons[j].pressed) active = true;
        }
        const el = document.getElementById(`gp-item-${i}`);
        if (el) {
          if (active) el.classList.add("active");
          else el.classList.remove("active");
        }
      }
    }

    if (!device || !device.opened) {
      raf = requestAnimationFrame(tick);
      return;
    }
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let slot = 0; slot < MC_MAX_ROBOTS; slot++) {
      if (!pairMac[slot]) {
        continue;
      }
      const sel = document.querySelector(`select.slot-gamepad[data-idx="${slot}"]`);
      if (!sel || sel.value === "") continue;
      
      const gpIdx = Number(sel.value);
      const gp = gps[gpIdx];
      if (!gp) {
        continue;
      }
      const joy = gamepadToJoystick(++seq, gp, null);
      try {
        await sendReport(MC_HID_RID_JOYSTICK, encodeJoystickOut(slot, joy));
      } catch (err) {
        log("send joystick err", String(err));
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

document.getElementById("btnConnect").addEventListener("click", () => connectDongle().catch((e) => log(String(e))));
document.getElementById("btnDisconnect").addEventListener("click", disconnectDongle);
document.getElementById("btnScan").addEventListener("click", async () => {
  const ch = Number(document.getElementById("chanDisp").textContent) || 6;
  discovered.clear();
  renderRobots();
  await sendReport(MC_HID_RID_DISCOVERY, encodeDiscoveryOut(ch));
  log("scan sent ch", ch);
});
document.getElementById("chkGlobalEn").addEventListener("change", async (e) => {
  const on = e.target.checked;
  const b = new Uint8Array(6);
  b.fill(0xff);
  await sendReport(MC_HID_RID_ENABLE, encodeEnable(on, b));
  log("enable global", on);
});

buildSlots();
setDongleUi(false);
log("Ready. Connect dongle, scan, pair a slot, enable, then use gamepads at indices 0–3.");
