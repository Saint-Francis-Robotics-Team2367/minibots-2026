/** USB filter + HID report IDs — must match firmware/common/minicore_protocol.h */
export const MINICORE_USB_VID = 0x303a;
export const MINICORE_USB_PID = 0x4002;

export const MC_MSG_JOYSTICK = 0x01;
export const MC_MSG_ENABLE = 0x02;
export const MC_MSG_HEARTBEAT = 0x03;
export const MC_MSG_DISCOVERY_REQ = 0x04;
export const MC_MSG_DISCOVERY_RESP = 0x05;

export const MC_HID_RID_JOYSTICK = 0x01;
export const MC_HID_RID_ENABLE = 0x02;
export const MC_HID_RID_DISCOVERY = 0x04;
export const MC_HID_RID_PAIR = 0x10;
export const MC_HID_RID_UNPAIR = 0x11;
export const MC_HID_RID_SPECTRUM_SCAN = 0x12;

export const MC_HID_RID_HEARTBEAT_IN = 0x03;
export const MC_HID_RID_DISCOVERY_IN = 0x05;
export const MC_HID_RID_SPECTRUM_IN = 0x07;
export const MC_HID_RID_DONGLE_STATUS = 0xfe;

export const MC_ROBOT_ID_MAX = 16;
export const MC_JOY_AUX_BYTES = 8;
export const MC_MAX_ROBOTS = 4;

export const MC_HID_OUT_JOYSTICK_LEN = 25;
export const MC_HID_OUT_ENABLE_LEN = 8;
export const MC_HID_OUT_DISCOVERY_LEN = 8;
export const MC_HID_OUT_PAIR_LEN = 8;
export const MC_HID_OUT_UNPAIR_LEN = 8;
export const MC_HID_OUT_SPECTRUM_LEN = 8;

export const MC_HID_IN_HEARTBEAT_LEN = 20;
export const MC_HID_IN_DISCOVERY_LEN = 24;
export const MC_HID_IN_SPECTRUM_LEN = 32;
export const MC_HID_IN_STATUS_LEN = 16;

export const MC_WIFI_CH_24_MAX = 14;
