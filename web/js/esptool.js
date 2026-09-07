/**
 * esptool-js wrapper + the port-ownership guard.
 *
 * ## The trap this module exists to prevent
 *
 * /code-robot runs two serial consumers on one page — the raw-REPL module in
 * serial.js and esptool-js — and they cannot share a port. Read from the pinned
 * bundle rather than assumed:
 *
 *   Transport.connect()   calls `this.device.open({baudRate, …})` itself.
 *   Transport.disconnect() cancels its reader, then `await waitForUnlock(400)`,
 *                          then `device.close()`.
 *   waitForUnlock(ms)      `for (;;)` while `device.readable.locked ||
 *                          device.writable.locked` — it SPINS FOREVER, with no
 *                          timeout, if anything else still holds a lock.
 *
 * So a port whose reader serial.js has not released does not produce an error
 * when esptool takes it: the page hangs, silently, inside waitForUnlock. That is
 * why ownership is an explicit state machine here and why claim() refuses rather
 * than waits.
 *
 * ## Pinning
 *
 * esptool-js 0.6.1 bundle.js is ESM (`export{… ESPLoader, Transport,
 * ClassicReset …}`) served from jsdelivr with `access-control-allow-origin: *`,
 * so it loads via dynamic import() with no build step. Pinned exactly: this
 * writes to flash, and "latest" is not a version.
 */

const ESPTOOL_URL = "https://cdn.jsdelivr.net/npm/esptool-js@0.6.1/bundle.js";

/** Chip flash offsets. The dongle's come from its build/flash_args. */
export const ROBOT_MICROPYTHON_OFFSET = 0x1000;

let modulePromise = null;

/**
 * Load the bundle once per page.
 *
 * Deliberately not a static import: it is 214 KB and only two of the four pages
 * ever flash anything, so /control and the hub should not pay for it.
 */
export async function loadEsptool() {
  if (!modulePromise) {
    modulePromise = import(/* @vite-ignore */ ESPTOOL_URL).catch((err) => {
      // Reset so a later attempt can retry — a venue with flaky Wi-Fi should not
      // be stuck with one cached rejection for the life of the page.
      modulePromise = null;
      throw new Error(
        "Could not load the flashing library from the CDN. This step needs " +
          `internet access. (${err.message})`,
      );
    });
  }
  return modulePromise;
}

/* ── Port ownership ─────────────────────────────────────────────────────── */

/**
 * Exactly one owner of the shared port at a time.
 *
 * The guard refuses a claim instead of queueing it: a mode switch while the other
 * consumer is live is a bug in the calling page, and blocking on it would present
 * as the same silent hang this module exists to avoid.
 */
export class PortOwner {
  constructor() {
    /** @type {SerialPort | null} */
    this.port = null;
    /** @type {"none" | "repl" | "esptool"} */
    this.owner = "none";
  }

  /** @param {"repl" | "esptool"} who */
  claim(who) {
    if (this.owner !== "none" && this.owner !== who) {
      throw new Error(
        `The ${this.owner === "repl" ? "REPL" : "flasher"} is still using the ` +
          `serial port. Finish or cancel that first.`,
      );
    }
    this.owner = who;
  }

  /** @param {"repl" | "esptool"} who */
  release(who) {
    if (this.owner === who) {
      this.owner = "none";
    }
  }

  get busy() {
    return this.owner !== "none";
  }
}

/* ── Flashing ───────────────────────────────────────────────────────────── */

/**
 * Write images to a chip.
 *
 * The caller must already own the port (PortOwner.claim("esptool")) and must have
 * fully released any raw-REPL reader — see the header.
 *
 * @param {object} opts
 * @param {SerialPort} opts.port
 * @param {{ address: number, data: Uint8Array }[]} opts.images
 * @param {boolean} [opts.eraseAll] Full chip erase first. Required for the
 *   fresh-ESP32 path: MicroPython over a dirty flash leaves a filesystem that
 *   does not match the firmware.
 * @param {(pct: number, label: string) => void} [opts.onProgress]
 * @param {(line: string) => void} [opts.onLog]
 * @param {string} [opts.flashSize]
 * @param {"classic" | "usb-jtag" | "default"} [opts.resetMode]
 * @param {number} [opts.baudRate]
 */
export async function flash({
  port,
  images,
  eraseAll = false,
  onProgress,
  onLog,
  flashSize = "keep",
  resetMode = "default",
  baudRate = 115200,
}) {
  const mod = await loadEsptool();
  const { ESPLoader, Transport, ClassicReset, HardReset } = mod;

  const say = (s) => onLog?.(String(s).replace(/\r?\n$/, ""));
  // esptool-js writes progress and chip detection through a terminal-shaped
  // object; route it into the page's own log rather than the console.
  const terminal = {
    clean() {},
    writeLine: (d) => say(d),
    write: (d) => say(d),
  };

  const transport = new Transport(port, /* tracing */ false);
  let loader = null;
  try {
    loader = new ESPLoader({
      transport,
      baudrate: baudRate,
      terminal,
      // ClassicReset is the DTR/RTS sequence that puts a board with a UART
      // bridge (the robot's) into the bootloader with no button press. The
      // dongle has no bridge while its HID-only firmware runs, so it needs the
      // manual BOOT/RESET and gets the default here.
      ...(resetMode === "classic"
        ? { resetConstructors: { classicReset: ClassicReset, hardReset: HardReset } }
        : {}),
    });

    const chip = await loader.main();
    say(`Detected ${chip}`);

    // Total bytes across all images, so one bar covers the whole operation
    // rather than restarting per file.
    const total = images.reduce((n, i) => n + i.data.length, 0);
    const done = images.map(() => 0);

    await loader.writeFlash({
      // data must be a Uint8Array: writeFlash pads with Re(), which builds a
      // Uint8Array — verified in the 0.6.1 bundle, and older versions' binary
      // string would be mangled here.
      fileArray: images.map((i) => ({ address: i.address, data: i.data })),
      flashSize,
      eraseAll,
      compress: true,
      reportProgress(index, written) {
        done[index] = written;
        const sum = done.reduce((a, b) => a + b, 0);
        onProgress?.(
          Math.min(100, Math.round((sum / total) * 100)),
          `0x${images[index].address.toString(16)}`,
        );
      },
    });
    onProgress?.(100, "done");
    say("Flash written.");
  } finally {
    // Always disconnect, including on failure: leaving the transport holding the
    // port would make the next attempt hang in waitForUnlock instead of failing.
    try {
      await transport.disconnect();
    } catch (err) {
      /* the device may already be gone */
    }
    try {
      // Take the board out of the bootloader so it boots what was just written.
      await transport.setDTR?.(false);
    } catch (err) {
      /* optional */
    }
  }
}

/**
 * Fetch a flashable image and verify its SHA256 before it reaches flash.
 *
 * Mirrors the gate at flash-robot.sh:151. Worth the round trip: a truncated or
 * substituted image bricks the board in a way a student cannot diagnose, and the
 * manifest already carries the hash.
 *
 * @param {string} url
 * @param {string} [sha256] Lowercase hex. Skipped when absent.
 * @returns {Promise<Uint8Array>}
 */
export async function fetchImage(url, sha256) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} → HTTP ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (sha256) {
    const got = await sha256Hex(buf);
    if (got !== sha256.toLowerCase()) {
      throw new Error(
        `Checksum mismatch for ${url.split("/").pop()} — refusing to flash it. ` +
          `Expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`,
      );
    }
  }
  return buf;
}

/** @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  // crypto.subtle needs a secure context, which WebHID and Web Serial already
  // require, so this adds no constraint the page did not already have.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
