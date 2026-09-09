/**
 * Documentation pages — Home and everything under /docs. One job: say so when
 * the browser cannot do what the tools need.
 *
 * Everything else on these pages is static HTML and links — documentation
 * touches no hardware, so this imports none of the transport modules. Checking
 * the two APIs here means a student on Safari learns it while reading the docs
 * instead of from a tool page that looks functional until they click.
 *
 * Was hub.js, when / was a tool router rather than a wiki. Loaded by all four
 * documentation pages; the notice element is optional, so a page that omits it
 * is not an error.
 */

import { $ } from "./dom.js";

const hasHid = "hid" in navigator;
const hasSerial = "serial" in navigator;

if (!hasHid || !hasSerial) {
  const notice = $("noSupport");
  if (notice) {
    // Name what is missing. "Unsupported browser" tells a student nothing they
    // can act on; "no USB access" points at the actual cause. Reading the docs
    // works in any browser — it is only the three tools that won't open, so say
    // that rather than implying the whole site is broken.
    notice.textContent = hasHid
      ? "This browser can't open serial ports, so the robot code editor and the dongle flasher won't work. The driver station will. For all three, use Chrome or Edge."
      : "This browser can't reach USB devices, so none of the three tools will work. Reading these pages is fine anywhere — to use the tools, open the site in Chrome or Edge.";
    notice.hidden = false;
  }
}
