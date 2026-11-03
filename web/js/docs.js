/**
 * Documentation pages — Home and everything under /docs. Two jobs: say so when
 * the browser cannot do what the tools need, and keep the sidebar open on wide
 * screens in browsers too old for the CSS that does it.
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

// The sidebar is a <details>, closed in the markup so a phone shows one
// "Contents" line instead of the whole list. Wide screens show it open through
// ::details-content in docs.css; this covers browsers without that, where a
// closed <details> would hide the desktop sidebar. Only ever opens: closing it
// when a window narrows would throw away a choice the reader just made.
const toc = document.querySelector(".doc__toc");
if (toc instanceof HTMLDetailsElement) {
  const narrow = matchMedia("(max-width: 52rem)");
  const sync = () => {
    if (!narrow.matches) toc.open = true;
  };
  sync();
  narrow.addEventListener("change", sync);
}
