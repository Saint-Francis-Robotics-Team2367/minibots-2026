/**
 * "My board isn't in the port picker" — the help panel for the one failure that
 * stops a new student before they have done anything wrong.
 *
 * Chrome's serial picker comes up empty when the OS never enumerated a serial
 * device, and on Windows that is usually a missing driver. The two facts that
 * shape everything here, both verified rather than assumed:
 *
 *   1. The robot boards sit behind a CP210x bridge (10C4:EA60), and Windows does
 *      NOT install that driver by itself. Silicon Labs' own release notes say
 *      Windows Update auto-installs only for the ALTERNATE product ids EA63,
 *      EA7A and EA7B — and these boards use the default, EA60. So "just plug it
 *      in and wait" genuinely never resolves, and the manual install below is
 *      the only route.
 *   2. macOS needs no driver at all. Apple has shipped its own CP210x and CH340
 *      drivers since Big Sur (AppleUSBSLCOM.dext and AppleUSBCHCOM, in
 *      /System/Library/DriverExtensions). Installing a vendor kext there
 *      CONFLICTS with Apple's and can stop a Mac that was working — which makes
 *      the top search result for "CH340 mac driver" actively harmful. The Mac
 *      pane therefore tells a student to install nothing, and says so first,
 *      before they go looking.
 *
 * The dongle is a different device with a different answer: its USB is wired
 * straight to the ESP32-S3's own pins with no bridge chip at all
 * (docs/MINICORE_CLAUDE.md:83), so it needs no driver on any OS and an empty
 * picker there means it is not in its ROM bootloader. Handing that student a
 * driver download would send them to debug the wrong thing, so `device` selects
 * between the two and the dongle's panel has no OS switcher — there is nothing
 * to branch on when the answer is the same everywhere.
 */

/** Verified live: HTTP 200, application/zip, 292462 bytes, sent as an attachment. */
const CP210X_URL =
  "https://www.silabs.com/documents/public/software/CP210x_Universal_Windows_Driver.zip";

/** WCH's own page, for the minority of boards that report as CH340 instead. */
const CH340_URL = "https://www.wch-ic.com/downloads/CH341SER_EXE.html";

/**
 * Which OS, for preselecting a pane.
 *
 * Everywhere else this codebase detects capabilities, not platforms — `"serial"
 * in navigator` and friends (docs.js:17). That rule is right when a feature test
 * exists, and it is inapplicable here: there is no observable capability that
 * answers "does this machine already have a CP210x driver". A user-agent string
 * is the only signal that exists for the question, so this is a different
 * category rather than a departure.
 *
 * Wrong answers are cheap by construction: both panes stay reachable, nothing in
 * the copy claims to have detected anything, and an unrecognised platform gets
 * its own honest pane rather than being shown Windows instructions by default.
 *
 * `nav` is a parameter so this is testable under plain node, which is how the
 * rest of web/test/ works — it injects fakes rather than emulating a browser.
 *
 * @param {{userAgentData?: {platform?: string}, platform?: string}} [nav]
 * @returns {"windows" | "mac" | "other"}
 */
export function detectOS(nav = globalThis.navigator) {
  // userAgentData first: navigator.platform is deprecated and frozen on some
  // builds. Available in practice here because Web Serial is Chromium-only, so
  // any browser that can reach these pages has it — but not relied upon.
  const hint = nav?.userAgentData?.platform || nav?.platform || "";
  const s = String(hint).toLowerCase();
  // Mac before Windows, and the order is load-bearing: "darwin" CONTAINS "win",
  // so testing for Windows first sends every Darwin platform string down the
  // Windows branch — which would hand a Mac user a driver that can break their
  // machine. Caught by drivers.test.mjs.
  if (s.includes("mac") || s.includes("darwin")) {
    return "mac";
  }
  if (s.includes("win")) {
    // Also covers Windows on ARM, which reports the same. Fine: the driver zip
    // ships arm and arm64 builds alongside x86 and x64.
    return "windows";
  }
  return "other";
}

/* ── Copy ─────────────────────────────────────────────────────────────────── */

/**
 * The Windows install, as a sequence. Ordered because it genuinely is one: the
 * .inf cannot be run from inside the zip, and the driver only binds on the next
 * enumeration, so a student who skips the replug sees no change and concludes
 * the install failed.
 */
const WINDOWS_STEPS = [
  [
    "Download the CP210x driver.",
    "Silicon Labs makes the chip on the board, and they are the only source for its driver.",
  ],
  [
    "Unzip it.",
    "Right-click the file and choose Extract All. The installer is a file inside the zip, and it will not run while it is still in there.",
  ],
  [
    "Right-click <code>silabser.inf</code> and choose Install.",
    "There is no setup program to double-click — the <code>.inf</code> file <em>is</em> the installer. Approve the prompt Windows shows.",
  ],
  [
    "Unplug the robot, then plug it back in.",
    "Windows only hands out a <code>COM</code> port when it recognises the board, and it re-checks on the next plug-in.",
  ],
  [
    "Come back here and connect again.",
    "The picker should now list a <code>COM</code> port instead of being empty.",
  ],
];

/** Windows, robot: the case this whole panel exists for. */
function windowsRobot() {
  return `
    <p class="drv__lead">
      <strong>Windows needs a driver for this board, and it will not install
      itself.</strong> The robot reaches your computer through a CP210x
      USB-to-serial chip. Windows only auto-installs that driver for a few
      versions of the chip, and the one on these boards is not among them — so no
      <code>COM</code> port is ever created, and the picker has nothing to show.
      This takes about two minutes and you only do it once per computer.
    </p>
    <a class="btn btn--primary drv__get" href="${CP210X_URL}">
      Download the CP210x driver
    </a>
    <p class="drv__size">
      Zip, about 290&nbsp;KB, direct from Silicon Labs. Windows 10 and 11,
      including ARM.
    </p>
    <ol class="steps">
      ${WINDOWS_STEPS.map(
        ([act, why], i) => `
        <li class="step">
          <span class="step__n">${i + 1}</span>
          <span class="step__body">
            <span class="step__do">${act}</span>
            <span class="step__why">${why}</span>
          </span>
        </li>`,
      ).join("")}
    </ol>
    <p class="drv__tail">
      <strong>Still empty?</strong> Open Device Manager. If the board sits under
      <em>Other devices</em> with a yellow warning triangle, the driver did not
      take — do step 3 again. If it does not appear anywhere at all, that is a
      cable or power problem rather than a driver one: try another USB cable, and
      plug into the computer directly rather than through an unpowered hub.
    </p>
    <p class="drv__tail">
      <strong>Says <code>USB-SERIAL CH340</code> instead?</strong> A few boards
      use a different chip. Same idea, different download —
      <a href="${CH340_URL}">get WCH's CH340 driver</a> and install it the same
      way.
    </p>`;
}

/**
 * macOS, robot. Deliberately NOT .steps: "you already have it" is one fact, and
 * the list under it is alternatives to try, not an order to follow. Numbering
 * alternatives would read as a procedure and imply that step 2 is wrong until
 * step 1 is done. flash.css's own note on .steps makes the same distinction.
 */
function macRobot() {
  return `
    <p class="drv__lead">
      <strong>Your Mac already has this driver — do not install one.</strong>
      macOS has shipped its own CP210x and CH340 drivers since Big Sur, so there
      is nothing to download. The driver packages you will find by searching are
      built for much older versions of macOS and <em>conflict</em> with Apple's;
      installing one can stop a Mac that was working from seeing the board at
      all.
    </p>
    <p class="alert" data-kind="info">
      So an empty picker on a Mac is almost never a driver problem. In order of
      how often it turns out to be the cause: the <strong>USB cable</strong>
      (many are charge-only and have no data wires in them — try a different
      one), a <strong>hub</strong> in the way (plug into the Mac directly), the
      board <strong>not powered on</strong>, or <strong>another program holding
      the port</strong> — the Arduino IDE's serial monitor,
      <code>screen</code> or <code>mpremote</code> will each keep it to
      themselves, and only one program can have it at a time.
    </p>
    <p class="drv__tail">
      When it does appear, the robot shows up as <code>cu.usbserial-…</code>. And
      if you installed a Silicon Labs or WCH driver on this Mac at some point,
      that is worth undoing — remove it the way its own instructions say, then
      restart.
    </p>`;
}

/** Anything else. Linux and ChromeOS both land here, and both work. */
function otherRobot() {
  return `
    <p class="drv__lead">
      <strong>Nothing to install here either.</strong> Chrome and Edge can open
      serial ports on Linux and ChromeOS too, and the driver for this chip is
      already part of the Linux kernel — so an empty picker is almost always
      about <em>permission</em> to use the port rather than the driver.
    </p>
    <p class="alert" data-kind="info">
      Add yourself to the group that owns serial ports and then log out and back
      in — the new group does not apply to a session that is already open, which
      is the step people miss.
      <code>sudo usermod -a -G dialout $USER</code> on most distributions, or
      <code>uucp</code> instead of <code>dialout</code> on Arch.
    </p>
    <p class="drv__tail">
      The board appears as <code>/dev/ttyUSB0</code>. If it shows up and then
      disappears a moment later, <code>brltty</code> is probably claiming it — it
      recognises some USB-serial chips by id and takes them for braille
      displays. Removing that package, if you do not use one, frees the port.
    </p>`;
}

/**
 * The dongle, on every OS. One pane, no switcher: the answer does not vary, and
 * offering a Windows tab would imply there is a driver to install on it.
 */
function dongleAll() {
  return `
    <p class="drv__lead">
      <strong>The dongle needs no driver, on any operating system.</strong> Its
      USB port is wired straight to the chip's own USB pins — there is no
      separate serial chip in between for a driver to drive. So an empty picker
      here is not a driver problem, and installing one will not change anything.
    </p>
    <p class="alert" data-kind="info">
      The dongle only offers a port while it is in its <strong>ROM
      bootloader</strong>. Running its normal firmware it is a HID device with no
      serial port at all — which is how you know the firmware is working. An
      empty picker means the button sequence above did not take: hold
      <kbd>BOOT</kbd>, tap <kbd>RESET</kbd>, release <kbd>BOOT</kbd>, then try
      again without unplugging it.
    </p>
    <p class="drv__tail">
      In the bootloader it appears as <code>cu.usbmodem…</code> on macOS and as a
      <code>COM</code> port on Windows. If it never appears in either state, try
      a different USB-C cable before anything else — charge-only cables are the
      usual reason, and they look identical to working ones.
    </p>`;
}

/** Panes per device. Robot branches by OS; the dongle has one answer. */
const CONTENT = {
  robot: {
    ask: "Robot not showing up in the list?",
    panes: [
      ["windows", "Windows", windowsRobot],
      ["mac", "macOS", macRobot],
      ["other", "Linux / other", otherRobot],
    ],
  },
  dongle: {
    ask: "Dongle not showing up in the list?",
    panes: [["all", "All systems", dongleAll]],
  },
};

/* ── Mounting ─────────────────────────────────────────────────────────────── */

/**
 * Build the panel and put it in `mount`.
 *
 * Starts collapsed. It has to be reachable BEFORE anyone clicks connect — a
 * student who does not know what a driver is will not think to look after
 * failing — but a returning student whose driver is long installed should not
 * scroll past five steps on every load.
 *
 * A button and a [hidden] panel rather than <details>: every other disclosure on
 * this site is `.hidden = true/false` and none uses `.open`, and <details>'s one
 * real advantage — working with JavaScript off — is worth nothing for a panel
 * that JavaScript builds.
 *
 * @param {{mount: HTMLElement, device: "robot" | "dongle", os?: string}} opts
 * @returns {{reveal: () => void}} reveal() opens it from a failure path.
 */
export function mountDriverHelp({ mount, device, os = detectOS() }) {
  if (!mount) {
    // A page mid-build must not turn missing help into a second exception, the
    // same reason log() tolerates a missing list (dom.js:33).
    return { reveal() {} };
  }
  const spec = CONTENT[device];
  const active = spec.panes.some(([id]) => id === os) ? os : spec.panes[0][0];
  const uid = `drv-${device}`;

  const root = document.createElement("section");
  root.className = "drv";

  const bar = document.createElement("div");
  bar.className = "drv__bar";
  const ask = document.createElement("span");
  ask.className = "drv__ask";
  ask.textContent = spec.ask;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn btn--sm";
  toggle.id = `${uid}-toggle`;
  toggle.textContent = "How to fix it";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", `${uid}-body`);
  bar.append(ask, toggle);

  const body = document.createElement("div");
  body.className = "drv__body";
  body.id = `${uid}-body`;
  body.hidden = true;

  const tabbed = spec.panes.length > 1;

  // Only build the switcher when there is something to switch between.
  if (tabbed) {
    const tabs = document.createElement("div");
    tabs.className = "tabs drv__os";
    tabs.setAttribute("role", "tablist");
    // Its own label: /code-robot already has a tablist ("What to do"), and two
    // unlabelled ones are indistinguishable to a screen reader.
    tabs.setAttribute("aria-label", "Operating system");
    for (const [id, label] of spec.panes) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.id = `${uid}-tab-${id}`;
      b.setAttribute("aria-controls", `${uid}-pane-${id}`);
      b.setAttribute("aria-selected", String(id === active));
      b.textContent = label;
      b.addEventListener("click", () => select(id));
      tabs.append(b);
    }
    body.append(tabs);
  }

  for (const [id, , render] of spec.panes) {
    const pane = document.createElement("div");
    pane.id = `${uid}-pane-${id}`;
    // Only a tabpanel when there are actually tabs. The dongle has one pane and
    // no switcher, and a tabpanel with no tablist — labelled by a tab element
    // that was never built — is a dangling reference a screen reader announces
    // as a broken relationship. Plain content is the honest markup there.
    if (tabbed) {
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-labelledby", `${uid}-tab-${id}`);
    }
    pane.hidden = id !== active;
    // Static template strings written in this file — no user or device input
    // reaches them, so there is nothing here to inject.
    pane.innerHTML = render();
    body.append(pane);
  }

  /** Same shape as code-robot.js's selectMode(): flip aria-selected and hidden. */
  function select(which) {
    for (const [id] of spec.panes) {
      const on = id === which;
      document.getElementById(`${uid}-tab-${id}`)?.setAttribute("aria-selected", String(on));
      const pane = document.getElementById(`${uid}-pane-${id}`);
      if (pane) {
        pane.hidden = !on;
      }
    }
  }

  function setOpen(open) {
    body.hidden = !open;
    // Both, because they serve different readers: hidden is what the eye sees,
    // aria-expanded is what a screen reader announces.
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Hide" : "How to fix it";
  }

  toggle.addEventListener("click", () => setOpen(body.hidden));

  root.append(bar, body);
  mount.append(root);

  return {
    /**
     * Open it after a failed pick. Deliberately does not move focus or scroll:
     * the student may have cancelled that dialog on purpose, and nothing else
     * here hijacks the viewport to show #noSerial either. The log line that
     * accompanies this is already in an aria-live region.
     */
    reveal() {
      if (body.hidden) {
        setOpen(true);
      }
    },
  };
}
