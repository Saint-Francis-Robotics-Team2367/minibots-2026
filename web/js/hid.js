/**
 * WebHID transport to the MiniCore dongle — the DOM-free half.
 *
 * app.js's attach/connect/disconnect could not be lifted as they stand: each one
 * interleaves transport with driver-station DOM (`setDongleUi`, `renderSlots`,
 * `startGamepadLoop`, `broadcastDisable`), so moving them would drag the control
 * page's whole render layer into a shared module. What *is* page-neutral is
 * identifying a dongle, opening one, and putting a report on the wire — which is
 * all a second page needs to answer "is a dongle present?".
 *
 * Deliberately owns no state and touches no DOM. The caller holds the device.
 */

import { MINICORE_USB_VID, MINICORE_USB_PID } from "./constants.js";

/** @returns {boolean} */
export const hasWebHID = () => typeof navigator !== "undefined" && "hid" in navigator;

/**
 * @param {{ vendorId: number, productId: number }} dev
 * @returns {boolean}
 */
export const isDongle = (dev) =>
  dev.vendorId === MINICORE_USB_VID && dev.productId === MINICORE_USB_PID;

/**
 * Put one report on the wire, tolerating a closed device.
 *
 * Silent on a closed device by design, matching app.js:284: the control loop
 * fires continuously and a disconnect mid-frame is ordinary, not an error worth
 * a log line per frame.
 *
 * @param {HIDDevice | null} device
 * @param {number} reportId
 * @param {Uint8Array} data
 */
export async function sendReport(device, reportId, data) {
  if (!device || !device.opened) {
    return;
  }
  await device.sendReport(reportId, data);
}

/**
 * Dongles this origin has already been granted, without a picker or a gesture.
 *
 * getDevices() only returns devices the driver has chosen here before, so it
 * needs no user gesture — that is what makes every load after the first
 * automatic.
 *
 * A listing failure is not the same as an empty list — the driver station tells
 * those apart in what it logs — so `rethrow` lets a caller that cares see the
 * error while the default stays convenient.
 *
 * @param {{ rethrow?: boolean }} [opts]
 * @returns {Promise<HIDDevice[]>}
 */
export async function grantedDongles({ rethrow = false } = {}) {
  if (!hasWebHID()) {
    return [];
  }
  try {
    return (await navigator.hid.getDevices()).filter(isDongle);
  } catch (err) {
    if (rethrow) {
      throw err;
    }
    return [];
  }
}

/**
 * Ask the driver to pick a dongle. Requires a user gesture by design —
 * requestDevice() is the only call that can create the persistent grant, so the
 * first connection costs exactly one click and later ones cost none.
 *
 * @returns {Promise<HIDDevice | null>}
 */
export async function requestDongle() {
  if (!hasWebHID()) {
    return null;
  }
  const devs = await navigator.hid.requestDevice({
    filters: [{ vendorId: MINICORE_USB_VID, productId: MINICORE_USB_PID }],
  });
  return devs.length ? devs[0] : null;
}

/**
 * Open a dongle and attach an input-report listener.
 *
 * Does NOT guard against a concurrent open — that guard belongs to whoever owns
 * the `device` reference, because it is the assignment that races, not the open
 * (see app.js's `attaching` latch). Callers with a single device slot must hold
 * their own latch.
 *
 * @param {HIDDevice} dev
 * @param {(e: HIDInputReportEvent) => void} onInputReport
 * @returns {Promise<HIDDevice>}
 */
export async function openDongle(dev, onInputReport) {
  await dev.open();
  dev.addEventListener("inputreport", onInputReport);
  return dev;
}

/**
 * Detach and close. Idempotent, so a disconnect path can call it unconditionally.
 *
 * @param {HIDDevice | null} dev
 * @param {(e: HIDInputReportEvent) => void} onInputReport
 */
export async function closeDongle(dev, onInputReport) {
  if (!dev) {
    return;
  }
  dev.removeEventListener("inputreport", onInputReport);
  if (dev.opened) {
    await dev.close();
  }
}
