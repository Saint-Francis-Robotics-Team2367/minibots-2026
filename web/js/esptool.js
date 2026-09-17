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

/* ── Reset sequences ────────────────────────────────────────────────────── */

/**
 * Why this module supplies its own reset instead of using the library's.
 *
 * On these boards DTR and RTS do not reach the chip directly: they drive the
 * two-transistor auto-reset circuit, where DTR→IO0 and RTS→EN. What matters is
 * IO0's level AT THE INSTANT EN is released — that is when the ROM samples the
 * boot strap.
 *
 * esptool-js's ClassicReset (`class Fe` in the 0.6.1 bundle) drives the lines
 * one at a time, and `Transport.setRTS()` additionally re-sends DTR after every
 * RTS change. So going from "in reset" (DTR=0,RTS=1) to "IO0 low, out of reset"
 * (DTR=1,RTS=0) cannot happen atomically — it passes through DTR=1,RTS=1. In
 * that transient BOTH transistors conduct, EN goes high while IO0 has not
 * settled low, and the chip boots its application instead of the ROM loader.
 *
 * Measured on the bench, ESP32-D0WD-V3 behind a CP2102 (VID 0x10c4 PID 0xEA60):
 *
 *   ClassicReset,   50 ms and 550 ms → boot:0x13 (SPI_FAST_FLASH_BOOT)
 *   tight, atomic (0,1)→(1,0)        → boot:0x03, "waiting for download"
 *   tight + a deliberate (1,1) step  → boot:0x13   ← reproduces the bug exactly
 *
 * So esptool-js's seven connect attempts all reset the board into its own
 * firmware and every sync times out: "Failed to connect with the device".
 * esptool.py does not hit this because on Unix it defaults to UnixTightReset,
 * which sets both lines in a single TIOCMSET ioctl (esptool/reset.py:75).
 *
 * Web Serial can express that: `setSignals({dataTerminalReady, requestToSend})`
 * carries both flags in one call, and for a CP210x/CH34x bridge Chrome sends
 * them as one control transfer. That is the browser equivalent of the tight
 * reset, so this is the sequence to use — for the dongle too, since a dongle
 * already sitting in its ROM bootloader is unaffected by a reset that lands in
 * the same place.
 */
class TightReset {
  /** @param {{device: SerialPort}} transport @param {number} resetDelay */
  constructor(transport, resetDelay) {
    this.transport = transport;
    this.resetDelay = resetDelay;
  }

  /** Both signals in ONE call — the whole point. Never setDTR/setRTS here. */
  async #both(dataTerminalReady, requestToSend) {
    await this.transport.device.setSignals({ dataTerminalReady, requestToSend });
  }

  async reset() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await this.#both(false, false);
    await this.#both(true, true);
    await this.#both(false, true); // IO0 high, EN low — chip held in reset
    await sleep(100);
    await this.#both(true, false); // IO0 LOW as EN releases — enters ROM loader
    await sleep(this.resetDelay);
    await this.#both(false, false); // release IO0
  }
}

/**
 * A hard reset that actually resets.
 *
 * esptool-js's HardReset (`class Te`) is `await sleep(100); await setRTS(false)`
 * — it only ever DEASSERTS. Called after a flash, when the tight sequence has
 * already left RTS low, it is a no-op: measured on the bench it produced 0 bytes
 * and no boot banner, and the board stayed in the ROM loader. That is why the
 * reconnect after a reflash found no REPL. A reset needs EN pulled low and then
 * released, which is RTS true → false; that produced boot:0x13 and a full boot
 * log on the same board.
 *
 * @param {{device: SerialPort}} transport
 */
async function hardReset(transport) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // IO0 must stay high or the pulse drops it straight back into the ROM loader.
  await transport.device.setSignals({ dataTerminalReady: false, requestToSend: true });
  await sleep(100);
  await transport.device.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(50);
}

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
 * @param {number} [opts.baudRate]
 */
export async function flash({
  port,
  images,
  eraseAll = false,
  onProgress,
  onLog,
  flashSize = "keep",
  baudRate = 115200,
}) {
  const mod = await loadEsptool();
  const { ESPLoader, Transport } = mod;

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
    // classicReset is overridden with the tight sequence — see TightReset above
    // for the measurements. Note the shape: ESPLoader stores FACTORIES, not
    // classes, and calls them as `resetConstructors.classicReset(transport,
    // delay)`, so passing the class itself throws "Class constructor cannot be
    // invoked without 'new'". An arrow that news it up is what the field wants.
    //
    // usbJTAGSerialReset is deliberately left alone: constructResetSequence()
    // dispatches on PID, and a board reporting USB_JTAG_SERIAL_PID (0x1001) —
    // the dongle in its ROM bootloader — has no auto-reset circuit to get wrong,
    // so the library's own JTAG sequence is correct there. Only the UART-bridge
    // path (CP2102 here, CH340 on other boards) needed changing.
    loader = new ESPLoader({
      transport,
      baudrate: baudRate,
      terminal,
      resetConstructors: {
        classicReset: (t, d) => new TightReset(t, d),
      },
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
    // Reset BEFORE disconnecting, while the transport still holds the port.
    //
    // Two earlier versions of this got it wrong. The first called
    // transport.setDTR(false) AFTER disconnect() — a no-op twice over, since the
    // port was closed and dropping DTR is not a reset. The second called
    // loader.after("hard_reset"), which routes to the library's HardReset: that
    // one only DEASSERTS RTS, so after the tight sequence (which already leaves
    // RTS low) it did nothing at all — 0 bytes, no boot banner, board still in
    // the ROM loader. Either way the reconnect that follows a reflash found no
    // REPL and the six-file upload failed with "Not in raw REPL", while the flash
    // itself was perfect. hardReset() above pulses EN properly.
    if (loader) {
      try {
        await hardReset(transport);
      } catch (err) {
        say(`Could not reset the board: ${err.message} — power-cycle it by hand`);
      }
    }
    // Always disconnect, including on failure: leaving the transport holding the
    // port would make the next attempt hang in waitForUnlock instead of failing.
    try {
      await transport.disconnect();
    } catch (err) {
      /* the device may already be gone */
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
