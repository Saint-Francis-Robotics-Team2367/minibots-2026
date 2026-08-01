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

/* Allowed range for a neutral set from this page. Mirrors MC_NEUTRAL_TRIM_* in
 * minicore_protocol.h — the dongle and the robot both clamp to it, so keeping
 * the inputs' min/max here means the UI refuses what the firmware would silently
 * trim rather than letting the two drift apart. */
export const MC_NEUTRAL_TRIM_MIN_US = 1400;
export const MC_NEUTRAL_TRIM_MAX_US = 1600;
export const MC_NEUTRAL_DEFAULT_US = 1500;
