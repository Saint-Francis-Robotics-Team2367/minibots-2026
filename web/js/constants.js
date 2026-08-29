/** USB filter + HID report IDs — must match firmware/common/minicore_protocol.h */
export const MINICORE_USB_VID = 0x303a;
export const MINICORE_USB_PID = 0x4002;

export const MC_MSG_JOYSTICK = 0x01;
export const MC_MSG_ENABLE = 0x02;
export const MC_MSG_HEARTBEAT = 0x03;
export const MC_MSG_DISCOVERY_REQ = 0x04;
export const MC_MSG_DISCOVERY_RESP = 0x05;
export const MC_MSG_SET_NEUTRAL = 0x06;
export const MC_MSG_NEUTRAL_ACK = 0x07;

export const MC_HID_RID_JOYSTICK = 0x01;
export const MC_HID_RID_ENABLE = 0x02;
export const MC_HID_RID_DISCOVERY = 0x04;
export const MC_HID_RID_PAIR = 0x10;
export const MC_HID_RID_UNPAIR = 0x11;
export const MC_HID_RID_SET_NEUTRAL = 0x12;

export const MC_HID_RID_HEARTBEAT_IN = 0x03;
export const MC_HID_RID_NEUTRAL_IN = 0x06;
export const MC_HID_RID_DISCOVERY_IN = 0x05;
export const MC_HID_RID_DONGLE_STATUS = 0xfe;

export const MC_ROBOT_ID_MAX = 16;
export const MC_JOY_AUX_BYTES = 8;
export const MC_MAX_ROBOTS = 4;

export const MC_HID_OUT_JOYSTICK_LEN = 25;
export const MC_HID_OUT_ENABLE_LEN = 8;
export const MC_HID_OUT_DISCOVERY_LEN = 8;
export const MC_HID_OUT_PAIR_LEN = 8;
export const MC_HID_OUT_UNPAIR_LEN = 8;
export const MC_HID_OUT_SET_NEUTRAL_LEN = 8;

export const MC_HID_IN_HEARTBEAT_LEN = 26;
export const MC_HID_IN_DISCOVERY_LEN = 24;
export const MC_HID_IN_NEUTRAL_LEN = 12;
export const MC_HID_IN_STATUS_LEN = 16;

/* Bumped in lockstep with MC_PROTOCOL_VERSION in minicore_protocol.h. The dongle
 * reports the value it was BUILT with; if it differs from this, the dongle is
 * running firmware that predates (or postdates) this page and needs reflashing.
 * Surfacing that beats debugging a silent mismatch. */
export const MC_PROTOCOL_VERSION = 1;

/* Allowed range for a neutral set from this page — the full 1–2 ms RC window.
 * Mirrors MC_NEUTRAL_TRIM_* in firmware/common/minicore_policy.h (policy, NOT
 * the wire protocol — changing it needs no dongle reflash). The robot enforces
 * it authoritatively; these bounds exist so the UI refuses a bad value up front
 * instead of letting the driver discover it from the echo. */
export const MC_NEUTRAL_TRIM_MIN_US = 1000;
export const MC_NEUTRAL_TRIM_MAX_US = 2000;
export const MC_NEUTRAL_DEFAULT_US = 1500;
