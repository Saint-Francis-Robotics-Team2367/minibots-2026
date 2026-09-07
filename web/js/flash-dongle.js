/**
 * /flash-dongle — write the dongle's firmware over USB.
 *
 * Three images at the offsets the build itself declares (bootloader 0x0,
 * partition table 0x8000, app 0x10000). Those offsets and their SHA256s come from
 * firmware/prebuilt/manifest.json, which CI writes by parsing the build's
 * flash_args — so a partition-table change cannot silently desync this page.
 *
 * The images are fetched from raw.githubusercontent.com, which sends
 * `access-control-allow-origin: *`. Firebase Hosting only publishes web/, so
 * there is no same-origin copy; this step needs internet access, which is the
 * accepted trade recorded in the migration plan.
 */

import { $, log, clearLog } from "./dom.js";
import { flash, fetchImage } from "./esptool.js";

const RAW_BASE =
  "https://raw.githubusercontent.com/Saint-Francis-Robotics-Team2367/minibots-2026/main/";
const MANIFEST_URL = `${RAW_BASE}firmware/prebuilt/manifest.json`;

/** @type {{offset: string, path: string, sha256: string, bytes: number}[]} */
let images = [];
let flashSize = "keep";

/* ── Manifest ───────────────────────────────────────────────────────────── */

async function loadManifest() {
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const m = await res.json();
    const d = m.dongle || {};
    images = d.images || [];
    flashSize = d.flash_size || "keep";

    if (!images.length) {
      // The honest failure: CI has not built these yet, and there is nothing this
      // page can do about it. Say which job produces them.
      $("imgSummary").textContent =
        "No dongle firmware has been published yet. The esp32s3-dongle workflow " +
        "builds and commits it on the next push to firmware/esp32s3-dongle.";
      log("Manifest has no dongle images", "err");
      return;
    }

    $("buildRef").textContent = (d.built_from || "unknown").slice(0, 7);
    $("imgSummary").textContent = d.built_at
      ? `Built ${d.built_at} from ${String(d.built_from).slice(0, 7)}.`
      : "Firmware images ready.";
    renderImages();
    $("btnFlash").disabled = false;
    log(`Manifest loaded — ${images.length} images`, "go");
  } catch (err) {
    // Two very different causes, and telling a student "check your internet" when
    // the truth is "CI has not built this yet" sends them to debug the wrong thing.
    // A 404 on a path that is definitely in the repo means the file is not there.
    const missing = /HTTP 404/.test(err.message);
    $("imgSummary").textContent = missing
      ? "No dongle firmware has been published yet. The esp32s3-dongle workflow " +
        "builds and commits it on the next push to firmware/esp32s3-dongle — until " +
        "then, use scripts/flash-dongle.sh."
      : "Could not reach the firmware manifest. This page needs internet access to " +
        `fetch the images. (${err.message})`;
    log(
      missing ? "No published dongle firmware yet" : `Manifest failed: ${err.message}`,
      "err",
    );
  }
}

function renderImages() {
  const list = $("imgList");
  list.innerHTML = "";
  for (const img of images) {
    const li = document.createElement("li");
    const off = document.createElement("span");
    off.className = "imgs__off";
    off.textContent = img.offset;
    const name = document.createElement("span");
    name.className = "imgs__name";
    name.textContent = img.path.split("/").pop();
    const size = document.createElement("span");
    size.className = "imgs__size";
    size.textContent = `${(img.bytes / 1024).toFixed(1)} KB`;
    li.append(off, name, size);
    list.append(li);
  }
}

/* ── Flashing ───────────────────────────────────────────────────────────── */

async function run() {
  note("");
  $("doneNote").hidden = true;
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (err) {
    // An empty picker is the ordinary symptom of a dongle that is not in its
    // bootloader, so name that cause rather than reporting a cancelled dialog.
    log("No port selected — is the dongle in its bootloader? See the steps above.", "warn");
    return;
  }

  const prog = $("prog");
  const fill = $("progFill");
  prog.hidden = false;
  $("btnFlash").disabled = true;
  try {
    const fetched = [];
    for (const img of images) {
      log(`Fetching ${img.path.split("/").pop()}`);
      // Verified against the manifest's hash before it can reach flash — a
      // truncated image bricks the dongle in a way nobody can diagnose.
      fetched.push({
        address: Number.parseInt(img.offset, 16),
        data: await fetchImage(RAW_BASE + img.path, img.sha256),
      });
    }
    log("All images verified", "go");

    await flash({
      port,
      images: fetched,
      flashSize,
      // Nothing to pass: the dongle is already sitting in its ROM bootloader from
      // the manual BOOT/RESET. In that state it enumerates as PID 0x1001, which is
      // esptool-js's USB_JTAG_SERIAL_PID, so it selects the JTAG reset by itself.
      // Verified on a real dongle.
      onProgress: (pct, label) => {
        fill.style.width = `${pct}%`;
        note(`Writing ${label} — ${pct}%`);
      },
      onLog: (line) => log(line),
    });
    note("");
    $("doneNote").hidden = false;
    log("Dongle firmware written", "go");
  } catch (err) {
    note(String(err.message), "err");
    log(`Flash failed: ${err.message}`, "err");
  } finally {
    prog.hidden = true;
    fill.style.width = "0";
    $("btnFlash").disabled = !images.length;
  }
}

/** @param {string} msg @param {"err"|""} [kind] */
function note(msg, kind = "") {
  const el = $("flashNote");
  el.textContent = msg;
  if (kind) {
    el.dataset.kind = kind;
  } else {
    delete el.dataset.kind;
  }
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

if (!("serial" in navigator)) {
  $("noSerial").hidden = false;
  log("Web Serial unavailable in this browser", "err");
} else {
  loadManifest();
}

$("btnFlash").addEventListener("click", () => run());
$("btnClearLog").addEventListener("click", () => clearLog());

log("Dongle flasher ready");
