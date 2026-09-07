/**
 * Hub page. One job: say so when the browser cannot do what the tools need.
 *
 * Everything else on this page is static HTML and links — the hub touches no
 * hardware, so it does not import the transport modules. Checking the two APIs
 * here means a student on Safari learns it from the hub instead of from a tool
 * page that looks functional until they click.
 */

import { $ } from "./dom.js";

const hasHid = "hid" in navigator;
const hasSerial = "serial" in navigator;

if (!hasHid || !hasSerial) {
  const notice = $("noSupport");
  if (notice) {
    // Name what is missing. "Unsupported browser" tells a student nothing they
    // can act on; "no USB access" points at the actual cause.
    notice.textContent = hasHid
      ? "This browser can't open serial ports, so the code editor and dongle flasher won't work. The driver station will. For all three, use Chrome or Edge."
      : "This browser can't reach USB devices, so none of the tools below will work. Open this page in Chrome or Edge.";
    notice.hidden = false;
  }
}
