/**
 * Byte layouts for MiniCore — must match firmware/common/minicore_protocol.h (packed, no padding).
 */
import * as C from "./constants.js";

/** @returns {ArrayBuffer} */
export function encodeJoystickOut(controllerIndex, joy) {
  const buf = new ArrayBuffer(C.MC_HID_OUT_JOYSTICK_LEN);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o++, controllerIndex & 0xff);
  v.setUint8(o++, C.MC_MSG_JOYSTICK);
  v.setUint8(o++, joy.seq & 0xff);
  v.setInt16(o, joy.axis_lx, true);
  o += 2;
  v.setInt16(o, joy.axis_ly, true);
  o += 2;
  v.setInt16(o, joy.axis_rx, true);
  o += 2;
  v.setInt16(o, joy.axis_ry, true);
  o += 2;
  v.setInt16(o, joy.axis_lt, true);
  o += 2;
  v.setInt16(o, joy.axis_rt, true);
  o += 2;
  v.setUint16(o, joy.buttons & 0xffff, true);
  o += 2;
  for (let i = 0; i < C.MC_JOY_AUX_BYTES; i++) {
    v.setUint8(o++, (joy.aux && joy.aux[i]) || 0);
  }
  return buf;
}

/** @returns {ArrayBuffer} */
export function encodeEnable(enabled, targetMac6) {
  const buf = new ArrayBuffer(C.MC_HID_OUT_ENABLE_LEN);
  const v = new DataView(buf);
  let o = 0;
  v.setUint8(o++, C.MC_MSG_ENABLE);
  v.setUint8(o++, enabled ? 1 : 0);
  for (let i = 0; i < 6; i++) v.setUint8(o++, targetMac6[i] & 0xff);
  while (o < C.MC_HID_OUT_ENABLE_LEN) v.setUint8(o++, 0);
  return buf;
}

/** @returns {ArrayBuffer} */
export function encodeDiscoveryOut(channel) {
  const buf = new ArrayBuffer(C.MC_HID_OUT_DISCOVERY_LEN);
  const v = new DataView(buf);
  v.setUint8(0, C.MC_MSG_DISCOVERY_REQ);
  v.setUint8(1, channel & 0xff);
  for (let o = 2; o < C.MC_HID_OUT_DISCOVERY_LEN; o++) v.setUint8(o, 0);
  return buf;
}

/** @returns {ArrayBuffer} */
export function encodePairOut(controllerIndex, mac6) {
  const buf = new ArrayBuffer(C.MC_HID_OUT_PAIR_LEN);
  const v = new DataView(buf);
  v.setUint8(0, controllerIndex & 0xff);
  for (let i = 0; i < 6; i++) v.setUint8(1 + i, mac6[i] & 0xff);
  v.setUint8(7, 0);
  return buf;
}

/** @returns {ArrayBuffer} */
export function encodeUnpairOut(controllerIndex) {
  const buf = new ArrayBuffer(C.MC_HID_OUT_UNPAIR_LEN);
  const v = new DataView(buf);
  v.setUint8(0, controllerIndex & 0xff);
  for (let o = 1; o < C.MC_HID_OUT_UNPAIR_LEN; o++) v.setUint8(o, 0);
  return buf;
}

/**
 * Set the paired robot's per-motor neutral pulse widths.
 * Layout: slot index (1) + neutral_left_us (u16 LE) + neutral_right_us (u16 LE).
 * @returns {ArrayBuffer}
 */
export function encodeSetNeutralOut(slotIndex, leftUs, rightUs) {
  const buf = new ArrayBuffer(C.MC_HID_OUT_SET_NEUTRAL_LEN);
  const v = new DataView(buf);
  v.setUint8(0, slotIndex & 0xff);
  v.setUint16(1, leftUs & 0xffff, true);
  v.setUint16(3, rightUs & 0xffff, true);
  for (let o = 5; o < C.MC_HID_OUT_SET_NEUTRAL_LEN; o++) v.setUint8(o, 0);
  return buf;
}

/** Robot's report of the neutrals it is actually running (post-clamp). */
export function decodeNeutralAckIn(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.byteLength < C.MC_HID_IN_NEUTRAL_LEN) return null;
  let o = 0;
  const type = v.getUint8(o++);
  if (type !== C.MC_MSG_NEUTRAL_ACK) return null;
  const mac = new Uint8Array(6);
  for (let i = 0; i < 6; i++) mac[i] = v.getUint8(o++);
  const neutral_left_us = v.getUint16(o, true);
  o += 2;
  const neutral_right_us = v.getUint16(o, true);
  o += 2;
  // 1 = written to the robot's filesystem, so it survives a reset. 0 means the
  // values are live but a reboot reverts them.
  const stored = v.getUint8(o++) === 1;
  return { type, mac, neutral_left_us, neutral_right_us, stored };
}

export function decodeHeartbeatIn(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.byteLength < C.MC_HID_IN_HEARTBEAT_LEN) return null;
  let o = 0;
  const type = v.getUint8(o++);
  if (type !== C.MC_MSG_HEARTBEAT) return null;
  const mac = new Uint8Array(6);
  for (let i = 0; i < 6; i++) mac[i] = v.getUint8(o++);
  const robot_id_len = v.getUint8(o++);
  const idBytes = new Uint8Array(C.MC_ROBOT_ID_MAX);
  for (let i = 0; i < C.MC_ROBOT_ID_MAX; i++) idBytes[i] = v.getUint8(o++);
  const nullIdx = idBytes.indexOf(0);
  const dec = new TextDecoder();
  const robot_id = dec.decode(nullIdx >= 0 ? idBytes.subarray(0, nullIdx) : idBytes);
  const battery_pct = v.getUint8(o++);
  const status_flags = v.getUint8(o++);
  return { type, mac, robot_id_len, robot_id, battery_pct, status_flags };
}

export function decodeDiscoveryIn(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.byteLength < C.MC_HID_IN_DISCOVERY_LEN) return null;
  let o = 0;
  const type = v.getUint8(o++);
  if (type !== C.MC_MSG_DISCOVERY_RESP) return null;
  const mac = new Uint8Array(6);
  for (let i = 0; i < 6; i++) mac[i] = v.getUint8(o++);
  const robot_id_len = v.getUint8(o++);
  const idBytes = new Uint8Array(C.MC_ROBOT_ID_MAX);
  for (let i = 0; i < C.MC_ROBOT_ID_MAX; i++) idBytes[i] = v.getUint8(o++);
  const nullIdx = idBytes.indexOf(0);
  const dec = new TextDecoder();
  const robot_id = dec.decode(nullIdx >= 0 ? idBytes.subarray(0, nullIdx) : idBytes);
  return { type, mac, robot_id_len, robot_id };
}

export function decodeDongleStatus(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.byteLength < C.MC_HID_IN_STATUS_LEN) return null;
  return {
    wifi_channel: v.getUint8(0),
    paired_count: v.getUint8(1),
    global_enabled: v.getUint8(2),
    error_flags: v.getUint8(3),
    protocol_version: v.getUint8(4),
  };
}

/** Build joystick_packet_t fields from Gamepad and sequence */
export function gamepadToJoystick(seq, gp, aux) {
  const ax = (i) => (gp && gp.axes[i] !== undefined ? Math.round(gp.axes[i] * 32767) : 0);
  const btn = (n) => {
    let b = 0;
    if (!gp || !gp.buttons) return 0;
    for (let i = 0; i < n; i++) {
      const pressed = gp.buttons[i]?.pressed || gp.buttons[i] === 1;
      if (pressed) b |= 1 << i;
    }
    return b;
  };
  const auxArr = new Uint8Array(C.MC_JOY_AUX_BYTES);
  if (aux) for (let i = 0; i < Math.min(C.MC_JOY_AUX_BYTES, aux.length); i++) auxArr[i] = aux[i];
  return {
    seq: seq & 0xff,
    axis_lx: ax(0),
    axis_ly: ax(1),
    axis_rx: ax(2),
    axis_ry: ax(3),
    axis_lt: ax(4) || 0,
    axis_rt: ax(5) || 0,
    buttons: btn(16) & 0xffff,
    aux: Array.from(auxArr),
  };
}

